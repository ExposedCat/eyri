import { deepStrictEqual, equal, ok, rejects } from "node:assert/strict";
import { Database } from "@db/sqlite";
import {
  fetchVontobelHistory,
  fetchVontobelQuote,
  enrichPortfolioWithVontobelQuotes,
  VontobelHistoryCache,
  vontobelIsin,
} from "./vontobel.ts";
import { YahooHistoryCache } from "./yahoo.ts";
import { saveYahooMapping } from "./mappings.ts";
import { HistoricalDataError } from "./errors.ts";
import {
  buildAllTimeSeries,
  instrumentKey,
  loadAllTimeDataset,
} from "../tickers/alltime_chart.ts";
import type { IntegrationOrder, IntegrationPortfolioPosition } from "../integrations/types.ts";
import { buildIntegratedPerformanceList, buildIntegratedTickerList } from "../tickers/portfolio.ts";

const isin = "DE000VY8GR55";
const ticker = "VY8GR5";
const clock = () => new Date("2026-10-07T20:00:00Z");
const point = (date: string, bid: number) => ({
  timestamp: Date.parse(date),
  bid,
});
function market(
  calls: URL[],
  points = [
    point("2026-06-24", 2.03),
    point("2026-10-05", 0.48),
    point("2026-10-06", 0.41),
  ],
  issuer = "Vontobel Financial Products GmbH",
) {
  const request: typeof fetch = (input) => {
    const url = new URL(String(input));
    calls.push(url);
    if (url.hostname !== "markets.vontobel.com") {
      throw new Error("Unexpected provider");
    }
    if (url.pathname.includes("productdetailpage")) {
      return Promise.resolve(Response.json({
        isSuccess: true,
        payload: {
          data: { isin, currency: "EUR", issuer, productType: 3 },
          priceFactor: 1,
          lifeCycle: [{ type: 6, occurrence: "2028-01-21T12:00:00" }],
        },
      }));
    }
    return Promise.resolve(Response.json({
      isSuccess: true,
      payload: {
        series: [
          {
            isProduct: false,
            priceIdentifier: "991",
            points: [point("2026-06-24", 9999)],
          },
          {
            isProduct: true,
            priceIdentifier: isin,
            points: [...points].reverse(),
          },
        ],
      },
    }));
  };
  return request;
}

Deno.test("Vontobel WKNs derive checksum ISINs; ticker suffixes, ISINs and currency are validated", () => {
  for (const value of [ticker, " vy8gr5 ", "VY8GR5.F", "VY8GR5.DE", isin]) {
    equal(vontobelIsin({ ticker: value, currency: "EUR" }), isin);
  }
  equal(vontobelIsin({ ticker: "VY8GTE", currency: "EUR" }), "DE000VY8GTE6");
  equal(vontobelIsin({ ticker: "broker-local", isin, currency: "EUR" }), isin);
  for (
    const value of [
      "VOD",
      "MU",
      "DE000VY8GR56",
      "VY8GR5.US",
      "+MU.21JAN2028.C2500",
    ]
  ) {
    equal(vontobelIsin({ ticker: value, currency: "EUR" }), undefined);
  }
  equal(vontobelIsin({ ticker, currency: "USD" }), undefined);
  equal(
    vontobelIsin({ ticker, isin: "US5951121038", currency: "EUR" }),
    undefined,
  );
});

const latestQuote = (bid = .50) => ({
  isSuccess: true,
  payload: {
    data: {
      isin,
      currency: "EUR",
      issuer: "Vontobel Financial Products GmbH",
      productType: 3,
    },
    priceFactor: 1,
    price: {
      bid,
      ask: .51,
      latest: .51,
      currency: "EUR",
      isPercentPrice: false,
      latestTimestamp: "2026-10-07T19:56:36Z",
    },
  },
});

Deno.test("live Vontobel bid replaces the lower IBKR mark in native EUR and retains broker cost including fees", async () => {
  const holding: IntegrationPortfolioPosition = {
    integrationId: 7,
    integrationKind: "ibkr",
    account: "one",
    ticker,
    assetCategory: "WAR",
    currency: "EUR",
    amount: 1042,
    currentPrice: .4343,
    averageUnitPrice: .49383875,
    totalInput: 514.5799775,
    totalNow: 452.54,
    unrealizedPnl: -62.04,
    realizedPnl: null,
    dailyPnl: null,
    dailyPnlPercentage: null,
    dailyPnlBaseline: null,
    openedAt: new Date("2026-10-07"),
  };
  const source = structuredClone(holding);
  let requests = 0;
  const request: typeof fetch = async (input) => {
    requests++;
    ok(String(input).includes(`productdetailpage/${isin}`));
    return Response.json(latestQuote());
  };
  const [updated, secondAccount] = await enrichPortfolioWithVontobelQuotes([
    holding,
    { ...holding, integrationId: 8 },
  ], request);
  equal(requests, 1);
  equal(updated.currency, "EUR");
  equal(updated.currentPrice, .50);
  equal(secondAccount.currentPrice, .50);
  equal(updated.totalNow, 521);
  equal(updated.totalInput, 514.5799775);
  equal(updated.averageUnitPrice, .49383875);
  ok(Math.abs(updated.unrealizedPnl! - 6.4200225) < 1e-9);
  equal(updated.currentPriceSource, "vontobel_bid");
  equal(updated.currentPriceAsOf, "2026-10-07T19:56:36Z");
  const fx: typeof fetch = async () =>
    Response.json({ base: "USD", quote: "EUR", rate: .88972 });
  const report = await buildIntegratedPerformanceList({
    positions: [updated],
    request: fx,
    formatTicker: (t) => t,
  });
  ok(report.includes("VY8GR5 +1.25% +$7.22"));
  const detailed = await buildIntegratedTickerList({
    positions: [updated],
    request: fx,
    formatTicker: (t) => t,
  });
  ok(detailed.includes("$0.56 x 1042.00 ($0.56 +$0.01)"));
  deepStrictEqual(holding, source);
});

Deno.test("live warrant bids preserve zero and unknown costs, skip other instruments, and reject unavailable or mismatched quotes", async () => {
  const base = {
    ticker,
    assetCategory: "WAR",
    currency: "EUR",
    amount: 2,
    totalInput: null,
    currentPrice: .4343,
  } as IntegrationPortfolioPosition;
  const [zero] = await enrichPortfolioWithVontobelQuotes(
    [base],
    async () => Response.json(latestQuote(0)),
  );
  equal(zero.currentPrice, 0);
  equal(zero.totalNow, 0);
  equal(zero.unrealizedPnl, null);
  const skipped = [
    { ...base, assetCategory: "STK" },
    { ...base, ticker: "+MU.21JAN2028.C2500", assetCategory: "OPT" },
    { ...base, ticker: "OTHER" },
    { ...base, amount: 0 },
  ];
  deepStrictEqual(
    await enrichPortfolioWithVontobelQuotes(skipped, () => {
      throw new Error("No quote request expected");
    }),
    skipped,
  );
  await rejects(
    enrichPortfolioWithVontobelQuotes([base], async () =>
      new Response(null, { status: 503 })),
    /Vontobel bid quote unavailable/,
  );
  for (
    const change of [
      { bid: -1 },
      { bid: null },
      { currency: "USD" },
      { latestTimestamp: "invalid" },
      { isPercentPrice: true },
    ]
  ) {
    const payload = latestQuote();
    Object.assign(payload.payload.price, change);
    await rejects(
      fetchVontobelQuote(isin, async () => Response.json(payload)),
      /Invalid Vontobel bid quote/,
    );
  }
  const wrongCurrency = { ...base, currency: "USD", isin };
  await rejects(
    enrichPortfolioWithVontobelQuotes([wrongCurrency], async () =>
      Response.json(latestQuote())),
    /Vontobel bid quote unavailable/,
  );
});

Deno.test("Vontobel history selects warrant bids, sorts UTC day labels and accepts zero", async () => {
  const history = await fetchVontobelHistory(
    isin,
    "EUR",
    market([], [point("2026-06-24", 2.03), point("2026-06-25", 0)]),
  );
  deepStrictEqual(history, {
    symbol: "VONTOBEL:" + isin,
    currency: "EUR",
    instrumentType: "WARRANT",
    priceBasis: "BID",
    splits: [],
    bars: [{ date: "2026-06-24", close: 2.03 }, {
      date: "2026-06-25",
      close: 0,
    }],
  });
  for (
    const points of [[], [point("2026-06-24", -1)], [
      point("2026-06-24", 1),
      point("2026-06-24", 2),
    ], [{ timestamp: Date.parse("2026-06-24T12:00Z"), bid: 1 }]]
  ) {
    await rejects(fetchVontobelHistory(isin, "EUR", market([], points)));
  }
  await rejects(
    fetchVontobelHistory("DE000VY8GTE6", "EUR", market([])),
    /No Vontobel daily/,
  );
  await rejects(
    fetchVontobelHistory(
      isin,
      "EUR",
      () => Promise.resolve(new Response("", { status: 503 })),
    ),
    /HTTP 503/,
  );
  await rejects(
    fetchVontobelHistory(
      isin,
      "EUR",
      () => Promise.resolve(Response.json({ isSuccess: false })),
    ),
    /Invalid Vontobel/,
  );
});

Deno.test("Vontobel prices persist across restarts, share fetches, refresh recent bids and preserve finalized bids", async () => {
  const db = new Database(":memory:");
  const calls: URL[] = [];
  let now = clock();
  const points = [
    point("2026-06-24", 2.03),
    point("2026-10-05", 0.48),
    point("2026-10-06", 0.41),
  ];
  const request = market(calls, points);
  try {
    let cache = new VontobelHistoryCache(db, request, () => now);
    const [a, b] = await Promise.all([
      cache.get(isin, "2026-06-20"),
      cache.get(isin, "2026-06-20"),
    ]);
    deepStrictEqual(a, b);
    equal(calls.length, 2);
    cache = new VontobelHistoryCache(db, request, () => now);
    deepStrictEqual(await cache.get(isin, "2026-06-20"), a);
    equal(calls.length, 2);
    now = new Date(+now + 6 * 60_000);
    points[0].bid = 999;
    points[2].bid = 0.42;
    const updated = await cache.get(isin, "2026-06-20");
    equal(calls.length, 3);
    equal(updated.bars[0].close, 2.03);
    equal(updated.bars.at(-1)!.close, 0.42);
    now = new Date(+now + 6 * 60_000);
    deepStrictEqual((await cache.get(isin, "2026-06-20", "2026-07-01")).bars, [{
      date: "2026-06-24",
      close: 2.03,
    }]);
    equal(calls.length, 3);
  } finally {
    db.close();
  }
});

Deno.test("chart resolution automatically routes Vontobel warrants, checks purchase coverage and currency, and honors global overrides", async () => {
  const db = new Database(":memory:");
  const calls: URL[] = [];
  try {
    const cache = new YahooHistoryCache(db, market(calls), clock);
    const instrument = { ticker, currency: "EUR" };
    equal(await cache.resolve(instrument, "2026-06-24"), "VONTOBEL:" + isin);
    const history = await cache.get("VONTOBEL:" + isin, "2026-06-20");
    equal(history.bars[0].close, 2.03);
    equal(calls.length, 2);
    const restarted = new YahooHistoryCache(db, market(calls), clock);
    equal(
      await restarted.resolve(instrument, "2026-06-24"),
      "VONTOBEL:" + isin,
    );
    equal(calls.length, 2);
    await rejects(
      cache.resolve(instrument, "2026-06-23"),
      /Vontobel warrant history unavailable/,
    );
    await rejects(
      cache.resolve({ ...instrument, isin, currency: "USD" }),
      /Vontobel warrant history unavailable/,
    );
    saveYahooMapping(db, ticker, "CUSTOM");
    const overridden = new YahooHistoryCache(db, (input) => {
      ok(String(input).includes("finance.yahoo.com/v8/finance/chart/CUSTOM"));
      return Promise.resolve(
        Response.json({
          chart: {
            result: [{
              meta: { currency: "EUR", exchangeTimezoneName: "Europe/Berlin" },
              timestamp: [Date.parse("2026-10-06") / 1000],
              indicators: { quote: [{ close: [1] }] },
            }],
          },
        }),
      );
    }, clock);
    equal(await overridden.resolve(instrument), "CUSTOM");
  } finally {
    db.close();
  }
});

Deno.test("Vontobel failures do not persist coverage or recommend a Yahoo mapping", async () => {
  const db = new Database(":memory:");
  try {
    const cache = new YahooHistoryCache(
      db,
      market([], [], "Other Bank"),
      clock,
    );
    await rejects(
      cache.resolve({ ticker, currency: "EUR", assetCategory: "WAR" }),
      /Vontobel warrant history unavailable/,
    );
    equal(
      (db.prepare("SELECT COUNT(*) AS n FROM vontobel_coverage").get() as {
        n: number;
      }).n,
      0,
    );
    const error = new HistoricalDataError([{
      ticker,
      symbol: "VONTOBEL:" + isin,
    }]);
    equal(
      error.commands[0],
      "VY8GR5: Vontobel warrant history unavailable (DE000VY8GR55).",
    );
  } finally {
    db.close();
  }
});

Deno.test("six-character stock lookalikes can still resolve through Yahoo after issuer verification fails", async () => {
  const db = new Database(":memory:");
  try {
    const cache = new YahooHistoryCache(db, (input) => {
      const url = new URL(String(input));
      if (url.hostname === "markets.vontobel.com") {
        return Promise.resolve(new Response("", { status: 404 }));
      }
      return Promise.resolve(Response.json({
        chart: {
          result: [{
            meta: { currency: "EUR", exchangeTimezoneName: "Europe/Berlin" },
            timestamp: [Date.parse("2026-10-06") / 1000],
            indicators: { quote: [{ close: [12] }] },
          }],
        },
      }));
    }, clock);
    equal(
      await cache.resolve({
        ticker: "VABCDE",
        currency: "EUR",
        assetCategory: "STK",
      }),
      "VABCDE",
    );
  } finally {
    db.close();
  }
});

Deno.test("expired Vontobel warrants retain their finalized history indefinitely without network access", async () => {
  const db = new Database(":memory:");
  try {
    const request: typeof fetch = async (input, init) => {
      const response = await market([])(input, init);
      const data = await response.json();
      if (String(input).includes("productdetailpage")) {
        data.payload.lifeCycle[0].occurrence = "2026-10-06T12:00:00";
      }
      return Response.json(data);
    };
    const now = () => new Date("2026-10-10T20:00:00Z");
    const first = await new VontobelHistoryCache(db, request, now).get(
      isin,
      "2026-06-20",
    );
    const offline: typeof fetch = () => Promise.reject(new Error("No network"));
    const cached = await new VontobelHistoryCache(
      db,
      offline,
      () => new Date("2027-01-01"),
    ).get(isin, "2026-06-20");
    deepStrictEqual(cached, first);
  } finally {
    db.close();
  }
});

Deno.test("a Vontobel outage rejects the full chart with a provider-specific error and leaves no cached series", async () => {
  const db = new Database(":memory:");
  try {
    const cache = new YahooHistoryCache(db, market([], []), clock);
    await rejects(
      loadAllTimeDataset(
        db,
        {
          positions: [],
          orders: [{
            integrationId: 1,
            integrationKind: "ibkr",
            account: "one",
            ticker,
            currency: "EUR",
            assetCategory: "WAR",
            quantity: 1,
            price: 2,
            date: new Date("2026-06-24"),
          }],
          transactionBuckets: new Map(),
          bucketName: null,
          now: clock(),
        },
        1,
        "Test",
        cache,
      ),
      (error: unknown) => {
        ok(error instanceof HistoricalDataError);
        equal(
          error.message,
          "Failed to fetch historical data:\n- VY8GR5: Vontobel warrant history unavailable (DE000VY8GR55).",
        );
        return true;
      },
    );
    equal(
      (db.prepare("SELECT COUNT(*) AS n FROM vontobel_coverage").get() as {
        n: number;
      }).n,
      0,
    );
    equal(
      (db.prepare("SELECT COUNT(*) AS n FROM alltime_series_cache").get() as {
        n: number;
      }).n,
      0,
    );
  } finally {
    db.close();
  }
});

Deno.test("warrant chart uses bids per warrant with EUR conversion and preserves the live broker endpoint", async () => {
  const order: IntegrationOrder = {
    integrationId: 1,
    integrationKind: "ibkr",
    account: "one",
    ticker,
    currency: "EUR",
    assetCategory: "WAR",
    quantity: 10,
    price: 2,
    date: new Date("2026-06-24"),
  };
  const history = await fetchVontobelHistory(
    isin,
    "EUR",
    market([], [point("2026-06-24", 2.03), point("2026-06-25", 3)]),
  );
  const series = buildAllTimeSeries(
    {
      orders: [order],
      positions: [{
        integrationId: 1,
        integrationKind: "ibkr",
        account: "one",
        ticker,
        currency: "EUR",
        assetCategory: "WAR",
        amount: 10,
        averageUnitPrice: 2,
        currentPrice: 4,
        totalInput: 20,
        totalNow: 40,
        unrealizedPnl: 20,
        realizedPnl: null,
        dailyPnl: null,
        dailyPnlPercentage: null,
        dailyPnlBaseline: null,
        openedAt: order.date,
      }],
      transactionBuckets: new Map(),
      bucketName: null,
      now: new Date("2026-06-26"),
    },
    new Map([[instrumentKey(order), history]]),
    new Map([["EUR", 1.1]]),
  );
  equal(series.find((p) => p.date === "2026-06-25")!.percentage, 50);
  ok(Math.abs(series.find((p) => p.date === "2026-06-25")!.gain - 11) < 1e-9);
  equal(series.at(-1)!.percentage, 100);
  equal(series.at(-1)!.gain, 22);
});
