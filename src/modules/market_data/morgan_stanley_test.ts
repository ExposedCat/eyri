import { deepStrictEqual, equal, ok, rejects } from "node:assert/strict";
import { Database } from "@db/sqlite";
import {
  fetchMorganStanleyHistory,
  MorganStanleyHistoryCache,
  morganStanleyIsin,
} from "./morgan_stanley.ts";
import { YahooHistoryCache } from "./yahoo.ts";
import { HistoricalDataError } from "./errors.ts";
import { saveYahooMapping } from "./mappings.ts";
import { loadAllTimeDataset } from "../tickers/alltime_chart.ts";

const isin = "DE000MN03RW5";
const symbol = "MORGAN_STANLEY:" + isin;
const instrument = { ticker: "MN03RW", currency: "EUR", assetCategory: "WAR" };
const clock = () => new Date("2026-10-15T09:00:00Z");
// Response structure and daily quote timestamps from the issuer's product chart.
const chart = () => ({
  ProductName: "Produkt",
  UnderlyingName: "Basiswert",
  IsNormalized: false,
  Diagrams: [
    {
      Name: "Basiswert",
      ValueSuffix: "USD",
      Data: [[Date.parse("2026-10-14T20:00:18Z"), 35.79]],
    },
    {
      Name: "Produkt",
      ValueSuffix: "EUR",
      Data: [
        [Date.parse("2026-10-14T20:00:18Z"), 1.04],
        [Date.parse("2026-10-13T20:00:17Z"), 1.21],
        [Date.parse("2026-10-12T20:00:13Z"), 1.27],
      ],
    },
  ],
});
const page = (issuer = "MORGAN STANLEY &amp; CO. INTERNATIONAL PLC") => `
<span data-prop="Isin">${isin}</span>
<span data-prop="IssuerName">${issuer}</span>
<span data-prop="CurrencyIsoCode">EUR</span>
<span data-prop="ProductTypeTranslation">Optionsschein</span>
<div data-friendly-id="${isin}" data-endpoint="ProductChartData"></div>`;
function market(calls: URL[], html = page(), data = chart()): typeof fetch {
  return (input) => {
    const url = new URL(String(input));
    calls.push(url);
    equal(url.hostname, "zertifikate.morganstanley.com");
    if (url.pathname.startsWith("/produktdetails/")) {
      equal(url.pathname, "/produktdetails/de000mn03rw5");
      return Promise.resolve(new Response(html));
    }
    equal(url.pathname, "/de-DE/UnitedChart/ProductChartData");
    equal(url.searchParams.get("friendlyId"), isin);
    equal(url.searchParams.get("period"), "FiveYears");
    return Promise.resolve(Response.json(data));
  };
}

Deno.test("Morgan Stanley candidate identifiers validate WKNs, checksums and explicit ISINs", () => {
  for (
    const ticker of [
      "MN03RW",
      " mn03rw ",
      "MN03RW.DE",
      "MN03RW.F",
      "MN03RW.SG",
      isin,
    ]
  ) {
    equal(morganStanleyIsin({ ticker, currency: "EUR" }), isin);
  }
  equal(morganStanleyIsin({ ticker: "local", isin, currency: "EUR" }), isin);
  for (
    const ticker of [
      "MU",
      "MS",
      "MN03RW.US",
      "DE000MN03RW6",
      "VY8GR5",
      "../../MN03RW",
    ]
  ) {
    equal(morganStanleyIsin({ ticker, currency: "EUR" }), undefined);
  }
  equal(morganStanleyIsin({ ticker: "MN03RW", currency: "USD" }), undefined);
  equal(morganStanleyIsin({ ...instrument, isin: "US86800U3023" }), undefined);
});

Deno.test("Morgan Stanley daily history selects the unnormalized EUR product, preserves unit prices and Berlin dates", async () => {
  const data = chart();
  // A timestamp close to UTC midnight must retain the German trading date.
  data.Diagrams[1].Data.push([Date.parse("2026-01-02T23:05:00Z"), 0]);
  const history = await fetchMorganStanleyHistory(
    isin,
    "EUR",
    market([], page(), data),
  );
  equal(history.symbol, symbol);
  equal(history.priceBasis, "BID");
  deepStrictEqual(history.bars, [
    { date: "2026-01-03", close: 0 },
    { date: "2026-10-12", close: 1.27 },
    { date: "2026-10-13", close: 1.21 },
    { date: "2026-10-14", close: 1.04 },
  ]);
});

Deno.test("Morgan Stanley rejects normalized, foreign-currency, underlying-only and invalid daily series", async () => {
  const cases = [];
  const normalized = chart();
  normalized.IsNormalized = true;
  cases.push(normalized);
  const foreign = chart();
  foreign.Diagrams[1].ValueSuffix = "USD";
  cases.push(foreign);
  const underlying = chart();
  underlying.Diagrams.pop();
  cases.push(underlying);
  const duplicate = chart();
  duplicate.Diagrams[1].Data.push([...duplicate.Diagrams[1].Data[0]]);
  cases.push(duplicate);
  const empty = chart();
  empty.Diagrams[1].Data = [];
  cases.push(empty);
  const negative = chart();
  negative.Diagrams[1].Data[0][1] = -1;
  cases.push(negative);
  const malformed = chart();
  malformed.Diagrams[1].Data[0] = [0, 1];
  cases.push(malformed);
  for (const data of cases) {
    await rejects(
      fetchMorganStanleyHistory(isin, "EUR", market([], page(), data)),
    );
  }
});

Deno.test("Morgan Stanley cache shares concurrent fetches and persists history across restarts with range filtering", async () => {
  const db = new Database(":memory:");
  try {
    const calls: URL[] = [];
    const cache = new MorganStanleyHistoryCache(db, market(calls), clock);
    const [full, part] = await Promise.all([
      cache.get(isin, "2026-10-12"),
      cache.get(isin, "2026-10-13", "2026-10-14"),
    ]);
    equal(full.bars.length, 3);
    deepStrictEqual(part.bars, [{ date: "2026-10-13", close: 1.21 }]);
    equal(calls.length, 2);
    const offline: typeof fetch = () =>
      Promise.reject(new Error("Unexpected network call"));
    deepStrictEqual(
      await new MorganStanleyHistoryCache(db, offline, clock).get(
        isin,
        "2026-10-12",
      ),
      full,
    );
    const renewed = new MorganStanleyHistoryCache(
      db,
      market(calls),
      () => new Date("2026-10-15T09:06:00Z"),
    );
    await renewed.get(isin, "2026-10-12");
    equal(calls.length, 3); // Metadata reused; prices refreshed after five minutes.
  } finally {
    db.close();
  }
});

Deno.test("history resolution uses Morgan Stanley for MN03RW and validates purchase coverage and currency", async () => {
  const db = new Database(":memory:");
  try {
    const calls: URL[] = [];
    const cache = new YahooHistoryCache(db, market(calls), clock);
    equal(await cache.resolve(instrument, "2026-10-14"), symbol);
    deepStrictEqual(
      (await cache.get(symbol, "2026-10-14", "2026-10-15")).bars,
      [{ date: "2026-10-14", close: 1.04 }],
    );
    equal(calls.length, 2);
    await rejects(
      cache.resolve(instrument, "2025-01-01"),
      /Morgan Stanley warrant history unavailable/,
    );
    await rejects(
      cache.resolve({ ...instrument, isin, currency: "USD" }),
      /Morgan Stanley warrant history unavailable/,
    );
  } finally {
    db.close();
  }
});

Deno.test("Morgan Stanley issuer mismatches cannot price warrants or poison the cache; stock lookalikes retain Yahoo fallback", async () => {
  const db = new Database(":memory:");
  try {
    const wrongIssuer = new YahooHistoryCache(
      db,
      market([], page("Other Bank")),
      clock,
    );
    await rejects(
      wrongIssuer.resolve(instrument),
      /Morgan Stanley warrant history unavailable/,
    );
    equal(
      (db.prepare("SELECT count(*) AS n FROM morgan_stanley_products")
        .get() as { n: number }).n,
      0,
    );
    const cache = new YahooHistoryCache(
      db,
      (input) =>
        String(input).includes("morganstanley.com")
          ? Promise.resolve(new Response("", { status: 404 }))
          : Promise.resolve(Response.json({
            chart: {
              result: [{
                meta: {
                  currency: "EUR",
                  exchangeTimezoneName: "Europe/Berlin",
                },
                timestamp: [Date.parse("2026-10-14") / 1000],
                indicators: { quote: [{ close: [12] }] },
              }],
            },
          })),
      clock,
    );
    equal(
      await cache.resolve({ ...instrument, assetCategory: "STK" }),
      "MN03RW",
    );
    saveYahooMapping(db, instrument.ticker, "CUSTOM");
    equal(await cache.resolve(instrument), "CUSTOM");
  } finally {
    db.close();
  }
});

Deno.test("Morgan Stanley feed outages give the full chart an issuer-specific error without suggesting a Yahoo mapping", async () => {
  const db = new Database(":memory:");
  try {
    const cache = new YahooHistoryCache(
      db,
      () => Promise.resolve(new Response("", { status: 503 })),
      clock,
    );
    await rejects(
      loadAllTimeDataset(
        db,
        {
          positions: [],
          orders: [{
            ...instrument,
            integrationId: 7,
            integrationKind: "ibkr",
            account: "one",
            quantity: 465,
            price: 1.06,
            date: new Date("2026-10-14"),
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
          "Failed to fetch historical data:\n- MN03RW: Morgan Stanley warrant history unavailable (DE000MN03RW5).",
        );
        return true;
      },
    );
    equal(
      (db.prepare("SELECT count(*) AS n FROM alltime_series_cache").get() as {
        n: number;
      }).n,
      0,
    );
  } finally {
    db.close();
  }
});
