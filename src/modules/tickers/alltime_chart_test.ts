import {
  deepStrictEqual,
  equal,
  match,
  ok,
  rejects,
  throws,
} from "node:assert/strict";
import { Database } from "@db/sqlite";
import type {
  IntegrationAccountPerformance,
  IntegrationOrder,
  IntegrationPortfolioPosition,
} from "../integrations/types.ts";
import { dayAfter, type PriceHistory } from "../market_data/yahoo.ts";
import {
  type AllTimeDataset,
  buildAllTimeSeries,
  instrumentKey,
  loadAllTimeDataset as loadDataset,
  renderAllTimeChart,
  switchChartBenchmarks,
} from "./alltime_chart.ts";
import { buildChartBenchmark } from "./chart_benchmark.ts";
import {
  buildIntegratedAllTimePerformanceList,
  getOrderTransactionKey,
} from "./portfolio.ts";

// Keep instrument fixtures focused on their own histories; benchmark prices
// are a separate shared market-data request, never an instrument resolution.
function loadAllTimeDataset(...args: Parameters<typeof loadDataset>) {
  const cache = args[4]!;
  args[4] = {
    resolve: (...params: Parameters<typeof cache.resolve>) => cache.resolve(...params),
    get: (symbol: string, start: string, end?: string) => symbol === "CSPX.L"
      ? Promise.resolve({
        symbol, currency: "USD", instrumentType: "ETF", splits: [],
        bars: [{ date: start, close: 100 }, { date: dayAfter(end!, -1), close: 110 }],
      })
      : cache.get(symbol, start, end),
  } as never;
  return loadDataset(...args);
}

const now = new Date("2025-01-06T20:00:00Z");
function trade(
  quantity: number,
  price: number,
  date: string,
  currency = "USD",
  account = "one",
): IntegrationOrder {
  return {
    integrationId: account === "one" ? 1 : 2,
    integrationKind: "ibkr",
    account,
    ticker: "AAPL",
    currency,
    quantity,
    price,
    date: new Date(date),
    assetCategory: "STK",
  };
}
function holding(
  amount: number,
  cost: number,
  price: number,
  currency = "USD",
): IntegrationPortfolioPosition {
  return {
    integrationId: 1,
    integrationKind: "ibkr",
    account: "one",
    ticker: "AAPL",
    currency,
    amount,
    totalInput: cost,
    totalNow: amount * price,
    averageUnitPrice: cost / amount,
    currentPrice: price,
    unrealizedPnl: amount * price - cost,
    realizedPnl: null,
    dailyPnl: null,
    dailyPnlPercentage: null,
    dailyPnlBaseline: null,
    openedAt: new Date("2025-01-02"),
  };
}
function history(
  currency = "USD",
  bars = [{ date: "2025-01-02", close: 100 }, {
    date: "2025-01-03",
    close: 110,
  }, { date: "2025-01-06", close: 130 }],
): PriceHistory {
  return { symbol: "AAPL", currency, bars, splits: [] };
}

Deno.test("chart endpoint uses funding-based account return, including broker wallet sales across splits", async () => {
  const buy = trade(1, 100, "2025-01-02");
  const sell = {
    ...trade(-1, 60, "2025-01-03"),
    walletImpact: {
      currency: "EUR",
      netValue: 54,
      fxRate: 1.1,
      realisedProfitLoss: 14,
      taxes: [],
    },
  };
  const positions = [{
    ...holding(1, 50, 70),
    brokerValuations: [{
      currency: "EUR",
      totalInput: 40,
      totalNow: 63,
      unrealizedPnl: 23,
    }],
  }];
  const account: IntegrationAccountPerformance = {
    integrationId: 1,
    currency: "EUR",
    totalValue: 90,
    netContributions: 100,
    pnl: -10,
    deposits: 100,
    withdrawals: 0,
    cash: 27,
    ledgerCash: { EUR: 27 },
    openedAt: new Date("2025-01-01"),
    historyThrough: now,
    positionValue: 63,
    investmentValue: 63,
    reportedComponents: [{ currency: "EUR", cost: 40, pnl: 23 }, {
      currency: "EUR",
      cost: 40,
      pnl: 14,
    }],
  };
  const args = {
    positions,
    orders: [buy, sell],
    transactionBuckets: new Map<string, string>(),
    bucketName: null,
    now,
    accountPerformances: [account],
  };
  const h = { ...history(), splits: [{ date: "2025-01-03", ratio: 2 }] };
  const points = buildAllTimeSeries(
    args,
    new Map([[instrumentKey(buy), h]]),
    new Map([["USD", 1], ["EUR", 1.1]]),
  );
  equal(points.at(-1)?.gain, -11);
  equal(points.at(-1)?.percentage, -10);
});

Deno.test("all-time series replays purchases and FIFO sales, carries weekends, and matches /alltime gains", async () => {
  const orders = [trade(10, 100, "2025-01-02"), trade(-4, 120, "2025-01-03")];
  const positions = [holding(6, 600, 130)];
  const args = {
    positions,
    orders,
    transactionBuckets: new Map<string, string>(),
    bucketName: null,
    now,
  };
  const series = buildAllTimeSeries(
    args,
    new Map([[instrumentKey(orders[0]), history()]]),
    new Map([["USD", 1]]),
  );
  deepStrictEqual(
    series.map((p) => [p.date, p.gain, p.percentage]),
    [
      ["2025-01-01", 0, null],
      ["2025-01-02", 0, null],
      ["2025-01-03", 140, null],
      ["2025-01-04", 140, null],
      ["2025-01-05", 140, null],
      ["2025-01-06", 260, null],
    ],
  );
  const text = await buildIntegratedAllTimePerformanceList({
    numberOnly: true,
    ...args,
    formatTicker: (t) => t,
  });
  match(text, /\+\$260\.00/);
});

Deno.test("all-time series retains sold-only gains and isolates same-ticker FIFO lots per account", () => {
  const orders = [
    trade(1, 100, "2025-01-02"),
    trade(1, 200, "2025-01-02", "USD", "two"),
    trade(-1, 150, "2025-01-03", "USD", "two"),
    trade(-1, 130, "2025-01-06"),
  ];
  const points = buildAllTimeSeries(
    {
      positions: [],
      orders,
      transactionBuckets: new Map(),
      bucketName: null,
      now,
    },
    new Map([[instrumentKey(orders[0]), history()]]),
    new Map([["USD", 1]]),
  );
  equal(points[2].gain, -40);
  equal(points.at(-1)!.gain, -20);
  equal(points.at(-1)!.percentage, null);
});

Deno.test("live chart endpoint uses FX-inclusive broker valuation and agrees with alltime gains", async () => {
  const orders = [trade(2, 100, "2025-01-02")];
  const positions = [{
    ...holding(2, 200, 110),
    brokerValuations: [{
      currency: "EUR",
      totalInput: 170,
      totalNow: 198,
      unrealizedPnl: 27.99,
    }],
  }];
  const args = {
    positions,
    orders,
    transactionBuckets: new Map<string, string>(),
    bucketName: null,
    now,
  };
  const points = buildAllTimeSeries(
    args,
    new Map([[instrumentKey(orders[0]), history()]]),
    new Map([["USD", 1], ["EUR", 1.25]]),
  );
  equal(points.at(-1)!.gain, 27.99 * 1.25);
  equal(points.at(-1)!.percentage, null);
  const text = await buildIntegratedAllTimePerformanceList({
    numberOnly: true,
    ...args,
    request: async () => Response.json({ base: "USD", quote: "EUR", rate: .8 }),
    formatTicker: (ticker) => ticker,
  });
  match(text, /\+\$34\.99/);
});

Deno.test("bucket all-time curves consume earlier unselected purchases before selected lots", () => {
  const orders = [
    trade(4, 100, "2025-01-02"),
    trade(6, 200, "2025-01-03"),
    trade(-5, 300, "2025-01-06"),
  ];
  const buckets = new Map([[getOrderTransactionKey(orders[0]), "Core"]]);
  const prices = history("USD", [{ date: "2025-01-02", close: 100 }, {
    date: "2025-01-03",
    close: 200,
  }, { date: "2025-01-06", close: 250 }]);
  const core = buildAllTimeSeries(
    {
      positions: [],
      orders,
      transactionBuckets: buckets,
      bucketName: "Core",
      now,
    },
    new Map([[instrumentKey(orders[0]), prices]]),
    new Map([["USD", 1]]),
  );
  equal(core.at(-1)!.gain, 800);
  equal(core.at(-1)!.percentage, null);
  const rest = buildAllTimeSeries(
    {
      positions: [holding(5, 1000, 250)],
      orders,
      transactionBuckets: buckets,
      bucketName: null,
      now,
    },
    new Map([[instrumentKey(orders[0]), prices]]),
    new Map([["USD", 1]]),
  );
  equal(rest.at(-1)!.gain, 350);
  equal(rest.at(-1)!.percentage, null);
});

Deno.test("chart prices in pounds and broker prices in GBX use their own USD factors", () => {
  const orders = [trade(2, 500, "2025-01-02", "GBX")];
  const points = buildAllTimeSeries(
    {
      positions: [holding(2, 1000, 600, "GBX")],
      orders,
      transactionBuckets: new Map(),
      bucketName: null,
      now,
    },
    new Map([[
      instrumentKey(orders[0]),
      history("GBP", [{ date: "2025-01-02", close: 5.5 }, {
        date: "2025-01-03",
        close: 6,
      }]),
    ]]),
    new Map([["GBX", .02], ["GBP", 2]]),
  );
  equal(points[1].gain, 2);
  equal(points[1].percentage, null);
  equal(points.at(-1)!.gain, 4);
  equal(points.at(-1)!.percentage, null);
});

Deno.test("EUR warrant history and live endpoints compare native bids to native FIFO cost", () => {
  const orders = [
    trade(1142, .49, "2025-01-02", "EUR"),
    trade(-100, .52, "2025-01-03", "EUR"),
  ].map((o) => ({ ...o, ticker: "WARRANT", assetCategory: "WAR" }));
  const positions = [{
    ...holding(1042, 1042 * .49, .50, "EUR"),
    ticker: "WARRANT",
  }];
  const original = structuredClone({ orders, positions });
  const histories = new Map([[
    instrumentKey(orders[0]),
    history("EUR", [
      { date: "2025-01-02", close: .49 },
      { date: "2025-01-03", close: .50 },
    ]),
  ]]);
  const args = {
    positions,
    orders,
    transactionBuckets: new Map<string, string>(),
    bucketName: null,
    now,
  };
  for (const factor of [1, 1.12, 2]) {
    const points = buildAllTimeSeries(
      args,
      histories,
      new Map([["EUR", factor]]),
    );
    equal(points[1].gain, 0);
    const nativeGain = 1042 * .50 - 1042 * .49 + 100 * (.52 - .49);
    for (const point of points.slice(2)) {
      ok(Math.abs(point.gain - nativeGain * factor) < 1e-9);
      equal(point.percentage, null);
    }
  }
  deepStrictEqual({ orders, positions }, original);
});

Deno.test("historical splits preserve lot cost and adjust shares without inventing return", () => {
  const orders = [trade(2, 100, "2025-01-02"), trade(-2, 60, "2025-01-06")];
  const prices = history("USD", [{ date: "2025-01-02", close: 100 }, {
    date: "2025-01-03",
    close: 50,
  }, { date: "2025-01-06", close: 60 }]);
  prices.splits = [{ date: "2025-01-03", ratio: 2 }];
  const points = buildAllTimeSeries(
    {
      positions: [holding(2, 100, 60)],
      orders,
      transactionBuckets: new Map(),
      bucketName: null,
      now,
    },
    new Map([[instrumentKey(orders[0]), prices]]),
    new Map([["USD", 1]]),
  );
  equal(points[2].gain, 0);
  equal(points.at(-1)!.gain, 40);
  equal(points.at(-1)!.percentage, null);
});

Deno.test("incomplete trades, unmatched sales, missing closes and unreconciled holdings fail explicitly", () => {
  const buy = trade(2, 100, "2025-01-02");
  const base = {
    positions: [holding(2, 200, 130)],
    orders: [buy],
    transactionBuckets: new Map<string, string>(),
    bucketName: null,
    now,
  };
  const rates = new Map([["USD", 1]]),
    histories = new Map([[instrumentKey(buy), history()]]);
  equal(
    buildAllTimeSeries({ ...base, orders: [] }, histories, rates).at(-1)!.gain,
    260,
  );
  throws(
    () =>
      buildAllTimeSeries(
        { ...base, orders: [buy, trade(-3, 100, "2025-01-03")] },
        histories,
        rates,
      ),
    /no matching FIFO lot/,
  );
  throws(
    () => buildAllTimeSeries(base, new Map(), rates),
    /Historical closing price unavailable/,
  );
  throws(
    () =>
      buildAllTimeSeries(
        { ...base, positions: [holding(3, 300, 130)] },
        histories,
        rates,
      ),
    /trade history shows 2 held, but the broker reports 3/,
  );
});

Deno.test("computed series and rendered PNGs are cached persistently", async () => {
  const db = new Database(":memory:");
  try {
    const buy = trade(2, 100, "2025-01-02");
    const cache = {
      resolve: () => Promise.resolve("AAPL"),
      get: () => Promise.resolve(history()),
    };
    const args = {
      positions: [holding(2, 200, 130)],
      orders: [buy],
      transactionBuckets: new Map<string, string>(),
      bucketName: null,
      now,
    };
    const first = await loadAllTimeDataset(
      db,
      args,
      1,
      "Daniel",
      cache as never,
    );
    const second = await loadAllTimeDataset(
      db,
      args,
      1,
      "Daniel",
      cache as never,
    );
    deepStrictEqual(first, second);
    equal(
      (db.prepare("SELECT COUNT(*) AS count FROM alltime_series_cache")
        .get() as { count: number }).count,
      1,
    );
    const png = await renderAllTimeChart(db, [first]);
    deepStrictEqual([...png.slice(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
    const dimensions = new DataView(png.buffer, png.byteOffset);
    equal(dimensions.getUint32(16), 2400);
    equal(dimensions.getUint32(20), 1400);
    const repeat = await renderAllTimeChart(db, [second]);
    deepStrictEqual(repeat, png);
    equal(
      (db.prepare("SELECT COUNT(*) AS count FROM alltime_render_cache")
        .get() as { count: number }).count,
      1,
    );
    await Deno.writeFile("/tmp/eyri-alltime-test.png", png);
    const eur = { ...first, displayCurrency: "EUR", displayRate: .8 };
    const eurPng = await renderAllTimeChart(db, [eur]);
    ok(eurPng.length > 0);
    ok(!eurPng.every((byte, index) => byte === png[index]));
    deepStrictEqual(await renderAllTimeChart(db, [eur]), eurPng);
    deepStrictEqual(eur.points, first.points);
    await Deno.writeFile("/tmp/eyri-alltime-eur-test.png", eurPng);

    const other: AllTimeDataset = {
      ...first,
      userId: 2,
      label: "Other",
      points: first.points.map((p) => ({
        ...p,
        percentage: p.percentage === null ? null : -p.percentage / 2,
        gain: -p.gain / 2,
      })),
    };
    await Deno.writeFile(
      "/tmp/eyri-alltime-compare-test.png",
      await renderAllTimeChart(db, [first, other]),
    );
  } finally {
    db.close();
  }
});

Deno.test("chart retains trade classification when holding metadata omits it", async () => {
  const db = new Database(":memory:");
  const categories: (string | null | undefined)[] = [];
  const cache = {
    resolve: (source: { ticker: string; assetCategory?: string | null }) => {
      categories.push(source.assetCategory);
      return Promise.resolve(source.ticker);
    },
    get: () => Promise.resolve(history()),
  };
  try {
    for (const assetCategory of [undefined, null]) {
      await loadAllTimeDataset(db, {
        positions: [{ ...holding(1, 100, 130), assetCategory }],
        orders: [{ ...trade(1, 100, "2025-01-02"), assetCategory: "WAR" }],
        transactionBuckets: new Map(),
        bucketName: null,
        now,
      }, 1, "Test", cache as never);
    }
    deepStrictEqual(categories, ["WAR", "WAR"]);
  } finally {
    db.close();
  }
});

Deno.test("any failed or empty historical fetch rejects the entire chart and reports every affected instrument", async () => {
  const db = new Database(":memory:");
  const fetched: string[] = [];
  const cache = {
    resolve: (source: { ticker: string }) =>
      source.ticker === "BAD1"
        ? Promise.reject(new Error("No matching listing"))
        : Promise.resolve(source.ticker),
    get: (symbol: string) => {
      fetched.push(symbol);
      if (symbol === "BAD2") {
        return Promise.reject(new Error("Yahoo Finance returned HTTP 429."));
      }
      return Promise.resolve(
        history("USD", symbol === "EMPTY" ? [] : undefined),
      );
    },
  };
  try {
    await rejects(
      loadAllTimeDataset(
        db,
        {
          positions: [],
          orders: ["GOOD", "BAD1", "BAD2", "EMPTY"].map((ticker) => ({
            ...trade(1, 100, "2025-01-02"),
            ticker,
          })),
          transactionBuckets: new Map(),
          bucketName: null,
          now,
        },
        1,
        "Daniel",
        cache as never,
      ),
      (error: unknown) => {
        ok(error instanceof Error);
        equal(
          error.message,
          "Failed to fetch historical data:\n- /yahoo BAD1 BAD1\n- /yahoo BAD2 BAD2\n- /yahoo EMPTY EMPTY",
        );
        return true;
      },
    );
    deepStrictEqual(fetched, ["GOOD", "BAD2", "EMPTY"]);
    equal(
      (db.prepare("SELECT COUNT(*) AS count FROM alltime_series_cache")
        .get() as { count: number }).count,
      0,
    );
  } finally {
    db.close();
  }
});

Deno.test("Freedom24 option series uses per-contract premiums, retains sold gains and matches alltime gains", async () => {
  const ticker = "+AMD.15JAN2027.C280";
  const orders = [trade(2, 100, "2025-01-02"), trade(-1, 150, "2025-01-03")]
    .map((o) => ({ ...o, ticker, integrationKind: "f24" }));
  const positions = [{
    ...holding(1, 100, 130),
    ticker,
    integrationKind: "f24",
    historicalPriceMultiplier: 100,
  }];
  const args = {
    positions,
    orders,
    transactionBuckets: new Map<string, string>(),
    bucketName: null,
    now,
  };
  const premiums = history("USD", [{ date: "2025-01-02", close: 1 }, {
    date: "2025-01-03",
    close: 1.4,
  }, { date: "2025-01-06", close: 1.3 }]);
  const points = buildAllTimeSeries(
    args,
    new Map([[instrumentKey(orders[0]), premiums]]),
    new Map([["USD", 1]]),
  );
  equal(points[2].gain, 90);
  equal(points.at(-1)!.gain, 80);
  equal(points.at(-1)!.percentage, null);
  match(
    await buildIntegratedAllTimePerformanceList({
      numberOnly: true,
      ...args,
      formatTicker: (t) => t,
    }),
    /\+\$80.00/,
  );
});

Deno.test("failed option archive histories reject the complete chart and keep mapping commands usable", async () => {
  const db = new Database(":memory:");
  const ticker = "+BOTZ.15MAR2024.C33";
  try {
    await rejects(
      loadAllTimeDataset(
        db,
        {
          positions: [],
          orders: [{
            ...trade(1, 10, "2024-02-08"),
            ticker,
            integrationKind: "f24",
            assetCategory: "OPT",
          }],
          transactionBuckets: new Map(),
          bucketName: null,
          now,
        },
        1,
        "Daniel",
        {
          resolve: () => Promise.resolve("DATABENTO:BOTZ240315C00033000"),
          get: () => Promise.reject(new Error("Databento returned HTTP 503.")),
        } as never,
      ),
      (error: unknown) => {
        ok(error instanceof Error);
        equal(
          error.message,
          "Failed to fetch historical data:\n- /yahoo +BOTZ.15MAR2024.C33 BOTZ240315C00033000",
        );
        return true;
      },
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

Deno.test("chart follows VSCO purchases through the VSXY rename and preserves their bucket", async () => {
  const db = new Database(":memory:");
  const buy = { ...trade(2, 20, "2026-05-29"), ticker: "VSCO.US" };
  const sell = { ...trade(-1, 30, "2026-06-03"), ticker: "VSXY.US" };
  const calls: string[] = [];
  try {
    const dataset = await loadAllTimeDataset(
      db,
      {
        orders: [buy, sell],
        positions: [{ ...holding(1, 20, 40), ticker: "VSXY.US" }],
        transactionBuckets: new Map([[
          getOrderTransactionKey(buy),
          "investing",
        ]]),
        bucketName: "investing",
        now: new Date("2026-06-04"),
      },
      1,
      "Test",
      {
        resolve: (source: { ticker: string }) => {
          calls.push(source.ticker);
          return Promise.resolve("VSXY");
        },
        get: () =>
          Promise.resolve(history("USD", [
            { date: "2026-05-29", close: 20 },
            { date: "2026-06-02", close: 30 },
            { date: "2026-06-04", close: 40 },
          ])),
      } as never,
    );
    deepStrictEqual(calls, ["VSXY.US"]);
    equal(dataset.points.at(-1)!.gain, 30);
    equal(dataset.points.at(-1)!.percentage, null);
  } finally {
    db.close();
  }
});

Deno.test("chart stitches APH option predecessors across the split without using unrelated strike history", async () => {
  const db = new Database(":memory:");
  const buy = {
    ...trade(1, 600, "2026-08-31"),
    ticker: "+APH.15JAN2027.C200",
    integrationKind: "f24",
    assetCategory: "OPT",
  };
  const sell = {
    ...trade(-1, 400, "2026-09-04"),
    ticker: "+APH.15JAN2027.C100",
    integrationKind: "f24",
    assetCategory: "OPT",
  };
  const calls: unknown[] = [];
  try {
    const dataset = await loadAllTimeDataset(
      db,
      {
        orders: [buy, sell],
        positions: [{
          ...holding(1, 300, 500),
          ticker: sell.ticker,
          integrationKind: "f24",
        }],
        transactionBuckets: new Map([[
          getOrderTransactionKey(buy),
          "investing",
        ]]),
        bucketName: "investing",
        now: new Date("2026-09-07"),
      },
      1,
      "Test",
      {
        resolve: (
          source: { ticker: string },
          date: string | undefined,
          end: string,
        ) => {
          calls.push([source.ticker, date, end]);
          return Promise.resolve(source.ticker);
        },
        get: (symbol: string) =>
          Promise.resolve(history(
            "USD",
            symbol === buy.ticker
              ? [
                { date: "2026-08-31", close: 6 },
                { date: "2026-09-02", close: 8 },
                { date: "2026-09-04", close: 999 },
              ]
              : [
                { date: "2026-08-31", close: 999 },
                { date: "2026-09-03", close: 4 },
                { date: "2026-09-04", close: 4.5 },
              ],
          )),
      } as never,
    );
    deepStrictEqual(calls, [
      [buy.ticker, "2026-08-31", "2026-09-03"],
      [sell.ticker, undefined, "2026-09-08"],
    ]);
    equal(dataset.points.find((p) => p.date === "2026-08-31")!.gain, 0);
    equal(dataset.points.find((p) => p.date === "2026-09-02")!.gain, 200);
    equal(dataset.points.find((p) => p.date === "2026-09-03")!.gain, 200);
    equal(dataset.points.find((p) => p.date === "2026-09-04")!.gain, 250);
    equal(dataset.points.at(-1)!.gain, 300);
    equal(dataset.points.at(-1)!.percentage, null);
    const text = await buildIntegratedAllTimePerformanceList({
    numberOnly: true,
      orders: [buy, sell],
      positions: [{
        ...holding(1, 300, 500),
        ticker: sell.ticker,
        integrationKind: "f24",
      }],
      transactionBuckets: new Map([[getOrderTransactionKey(buy), "investing"]]),
      bucketName: "investing",
      formatTicker: (ticker) => ticker,
    });
    match(text, /\+\$300\.00/);
  } finally {
    db.close();
  }
});

Deno.test("a current option holding with no purchase is a history error, not a Yahoo mapping suggestion", async () => {
  const db = new Database(":memory:");
  try {
    await rejects(
      loadAllTimeDataset(
        db,
        {
          orders: [trade(1, 100, "2025-01-02")],
          positions: [holding(1, 100, 130), {
            ...holding(1, 100, 130),
            ticker: "OTHER",
            assetCategory: "OPT",
          }],
          transactionBuckets: new Map(),
          bucketName: null,
          now,
        },
        1,
        "Test",
        {
          resolve: () => {
            throw new Error("Should not fetch");
          },
        } as never,
      ),
      /Purchase history is missing for OTHER/,
    );
  } finally {
    db.close();
  }
});

Deno.test("a referral stock with no purchase adds its full value at zero cost only at the current endpoint", async () => {
  const db = new Database(":memory:");
  const buy = trade(1, 100, "2025-01-02");
  const gift = {
    ...holding(0.0809, 5, 100),
    ticker: "IBKR",
    assetCategory: "STK",
    openedAt: null,
  };
  const args = {
    orders: [buy],
    positions: [holding(1, 100, 130), gift],
    transactionBuckets: new Map<string, string>(),
    bucketName: null,
    now,
  };
  const calls: [string, string | undefined][] = [];
  try {
    const dataset = await loadAllTimeDataset(db, args, 1, "Test", {
      resolve: (source: { ticker: string }, date: string | undefined) => {
        calls.push([source.ticker, date]);
        return Promise.resolve(source.ticker);
      },
      get: (symbol: string) => Promise.resolve({ ...history(), symbol }),
    } as never);
    deepStrictEqual(calls, [["AAPL", "2025-01-02"], ["IBKR", "2025-01-06"]]);
    equal(dataset.points.find((p) => p.date === "2025-01-05")!.gain, 10);
    equal(dataset.points.at(-1)!.gain, 38.09);
    equal(dataset.points.at(-1)!.percentage, null);
    equal(args.orders.length, 1);
    equal(gift.totalInput, 5);
    equal(args.transactionBuckets.size, 0);
  } finally {
    db.close();
  }
});

Deno.test("a bucket containing only free stock charts without recorded orders and uses its broker currency valuation", () => {
  const gift = {
    ...holding(1, 50, 130),
    brokerValuations: [{
      currency: "EUR",
      totalInput: 40,
      totalNow: 90,
      unrealizedPnl: 50,
    }],
  };
  const args = {
    positions: [gift],
    orders: [],
    transactionBuckets: new Map<string, string>(),
    bucketName: "gifts",
    now,
  };
  const series = buildAllTimeSeries(
    args,
    new Map([[instrumentKey(gift), history()]]),
    new Map([["USD", 1], ["EUR", 1.1]]),
  );
  equal(series.length, 2);
  equal(series[0].gain, 0);
  equal(series[1].date, "2025-01-06");
  equal(Number(series[1].gain.toFixed(8)), 99);
  equal(series[1].percentage, null);
  equal(args.transactionBuckets.size, 0);
});

Deno.test("free stock cost assumptions preserve funding-based account reconciliation", () => {
  const gift = holding(1, 50, 130);
  const account: IntegrationAccountPerformance = {
    integrationId: 1,
    currency: "USD",
    totalValue: 140,
    netContributions: 100,
    pnl: 40,
    deposits: 100,
    withdrawals: 0,
    cash: 10,
    ledgerCash: { USD: 10 },
    openedAt: new Date("2025-01-01"),
    historyThrough: now,
    positionValue: 130,
    investmentValue: 130,
    reportedComponents: [{ currency: "USD", cost: 50, pnl: 80 }],
  };
  const series = buildAllTimeSeries(
    {
      positions: [gift],
      orders: [],
      transactionBuckets: new Map(),
      bucketName: null,
      now,
      accountPerformances: [account],
    },
    new Map([[instrumentKey(gift), history()]]),
    new Map([["USD", 1]]),
  );
  equal(series.at(-1)!.gain, 40);
  equal(series.at(-1)!.percentage, 40);
  equal(account.reportedComponents!.length, 1);
});

Deno.test("a post-split APH purchase fetches only the new contract; later failures suggest the correct mapping", async () => {
  const db = new Database(":memory:");
  const ticker = "+APH.15JAN2027.C100";
  const current = { ...holding(1, 400, 500), ticker, integrationKind: "f24" };
  const calls: string[] = [];
  const args = {
    orders: [{
      ...trade(1, 400, "2026-09-04"),
      ticker,
      integrationKind: "f24",
      assetCategory: "OPT",
    }],
    positions: [current],
    transactionBuckets: new Map<string, string>(),
    bucketName: null,
    now: new Date("2026-09-07"),
  };
  try {
    const dataset = await loadAllTimeDataset(db, args, 1, "Test", {
      resolve: (source: { ticker: string }) => {
        calls.push(source.ticker);
        return Promise.resolve(source.ticker);
      },
      get: () =>
        Promise.resolve(history("USD", [{ date: "2026-09-04", close: 4 }])),
    } as never);
    deepStrictEqual(calls, [ticker]);
    equal(dataset.points.at(-1)!.gain, 100);
    await rejects(
      loadAllTimeDataset(
        db,
        {
          ...args,
          positions: [{
            ...current,
            amount: 2,
            totalInput: 400,
            averageUnitPrice: 200,
          }],
          orders: [{
            ...args.orders[0],
            ticker: "+APH.15JAN2027.C200",
            date: new Date("2026-08-31"),
          }],
        },
        1,
        "Test",
        {
          resolve: (source: { ticker: string }) =>
            source.ticker === ticker
              ? Promise.reject(new Error("Unavailable new contract"))
              : Promise.resolve("APH270115C00200000"),
          get: () =>
            Promise.resolve(history("USD", [{ date: "2026-08-31", close: 4 }])),
        } as never,
      ),
      /Failed to fetch historical data:\n- \/yahoo \+APH\.15JAN2027\.C100 APH270115C00100000/,
    );
  } finally {
    db.close();
  }
});

Deno.test("bucket charts never invent benchmark deposits from USD/GBP/GBX/option purchase costs", async () => {
  const db = new Database(":memory:");
  const usd = trade(10, 100, "2025-01-02");
  const gbp = trade(1, 100, "2025-01-03", "GBP");
  const gbx = trade(1, 10000, "2025-01-03", "GBX");
  const option = { ...trade(2, 100, "2025-01-03"), ticker: "+AMD.15JAN2027.C280", integrationKind: "f24", assetCategory: "OPT" };
  const excluded = { ...trade(1000, 1000, "2025-01-02"), ticker: "OTHER" };
  const calls: string[] = [];
  const orders = [usd, gbp, gbx, option, excluded, trade(-10, 110, "2025-01-03")];
  const cache = {
    resolve: (source: { ticker: string; currency: string }) => Promise.resolve(`${source.ticker}:${source.currency}`),
    get: (symbol: string) => {
      calls.push(symbol);
      if (symbol === "CSPX.L") return Promise.resolve({
        ...history("USD", [
          { date: "2025-01-02", close: 100 },
          { date: "2025-01-03", close: 110 },
          { date: "2025-01-06", close: 121 },
        ]), symbol, instrumentType: "ETF",
      });
      const currency = symbol.split(":").at(-1)!;
      const price = symbol.startsWith("+") ? 1 : currency === "GBX" ? 10000 : 100;
      return Promise.resolve(history(currency, [
        { date: "2025-01-02", close: price },
        { date: "2025-01-03", close: price },
        { date: "2025-01-06", close: price * 1.1 },
      ]));
    },
  };
  try {
    const dataset = await loadDataset(db, {
      orders,
      positions: [holding(1, 100, 110, "GBP"), holding(1, 10000, 11000, "GBX"), {
        ...holding(2, 200, 110), ticker: option.ticker, integrationKind: "f24",
      }],
      transactionBuckets: new Map([usd, gbp, gbx, option].map(o => [getOrderTransactionKey(o), "Core"])),
      bucketName: "Core", now,
    }, 1, "Person", cache as never, async () => Response.json({ base: "USD", quote: "GBP", rate: .5 }));
    equal(dataset.benchmark, undefined);
    equal(calls.filter(symbol => symbol === "CSPX.L").length, 0);
    ok(!calls.some(s => s.startsWith("OTHER")));
    // The snapshot is serializable without broker credentials or raw orders.
    equal(JSON.parse(JSON.stringify(dataset)).benchmark, undefined);
  } finally { db.close(); }
});

Deno.test("switching index replays saved purchases before the visible window and restores frozen curves without fetching", async () => {
  const db = new Database(":memory:");
  const originalHistory = { ...history("USD", [
    { date: "2025-01-02", close: 100 }, { date: "2025-01-03", close: 110 },
    { date: "2025-01-06", close: 121 },
  ]), symbol: "CSPX.L", instrumentType: "ETF" };
  const purchases = [
    { date: "2025-01-02", amountUsd: 1000 }, { date: "2025-01-03", amountUsd: 1000 },
  ];
  const first: AllTimeDataset = {
      fundingReturnVersion: 1,
    userId: 1, label: "First", bucketName: null, displayCurrency: "EUR", displayRate: .8,
    points: [{ date: "2025-01-03", percentage: 5, gain: 100 }, { date: "2025-01-06", percentage: 15.5, gain: 310 }],
    benchmarkPurchases: purchases,
    benchmark: buildChartBenchmark(originalHistory, purchases, "2025-01-03", "2025-01-06"),
  };
  const second: AllTimeDataset = { ...first, userId: 2, label: "Second",
    benchmarkPurchases: purchases.slice(1),
    benchmark: buildChartBenchmark(originalHistory, purchases.slice(1), "2025-01-03", "2025-01-06"),
  };
  const saved = structuredClone([first, second]);
  const calls: string[] = [];
  try {
    const changed = await switchChartBenchmarks(db, [first, second], "momentum", {
      get: (symbol) => {
        calls.push(symbol);
        return Promise.resolve({ ...originalHistory, symbol, bars: [
          { date: "2025-01-02", close: 100 }, { date: "2025-01-03", close: 120 },
          { date: "2025-01-06", close: 150 },
        ] });
      },
    });
    deepStrictEqual(calls, ["IUMO.L", "IUMO.L"]);
    deepStrictEqual(changed.map(d => d.points), saved.map(d => d.points));
    deepStrictEqual(changed.map(d => d.benchmarkPurchases), saved.map(d => d.benchmarkPurchases));
    equal(changed[0].displayCurrency, "EUR");
    equal(changed[0].displayRate, .8);
    ok(Math.abs(changed[0].benchmark!.points[0].percentage - 10) < 1e-8);
    ok(Math.abs(changed[0].benchmark!.points.at(-1)!.percentage - 37.5) < 1e-8);
    ok(Math.abs(changed[1].benchmark!.points.at(-1)!.percentage - 25) < 1e-8);
    const failIfFetched = { get: () => { throw new Error("Unexpected price fetch"); } };
    const restored = await switchChartBenchmarks(db, JSON.parse(JSON.stringify(changed)), "sp500", failIfFetched);
    deepStrictEqual(restored.map(d => d.benchmark), saved.map(d => d.benchmark));
    const repeated = await switchChartBenchmarks(db, restored, "momentum", failIfFetched);
    deepStrictEqual(repeated.map(d => d.benchmark), changed.map(d => d.benchmark));
    deepStrictEqual([first, second], saved);
  } finally { db.close(); }
});
