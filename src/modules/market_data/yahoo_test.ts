import { deepStrictEqual, equal, ok, rejects } from "node:assert/strict";
import { Database } from "@db/sqlite";
import {
  dayAfter,
  fetchYahooHistory,
  missingRanges,
  quoteCurrency,
  type StockSplit,
  YahooHistoryCache,
} from "./yahoo.ts";

function market(
  splitEvents: StockSplit[] = [],
  calls: URL[] = [],
  empty = false,
): typeof fetch {
  return (input) => {
    const url = new URL(String(input));
    calls.push(url);
    const start = new Date(Number(url.searchParams.get("period1")) * 1000)
      .toISOString().slice(0, 10);
    const end = new Date(Number(url.searchParams.get("period2")) * 1000)
      .toISOString().slice(0, 10);
    const timestamp: number[] = [], close: number[] = [];
    for (let date = start; date < end; date = dayAfter(date)) {
      if (empty) continue;
      timestamp.push(Date.parse(date + "T14:30:00Z") / 1000);
      close.push(
        100 /
          splitEvents.reduce(
            (ratio, split) => split.date > date ? ratio * split.ratio : ratio,
            1,
          ),
      );
    }
    const splits = Object.fromEntries(
      splitEvents.filter((s) => s.date >= start && s.date < end).map(
        (s) => [s.date, {
          date: Date.parse(s.date + "T14:30:00Z") / 1000,
          numerator: s.ratio,
          denominator: 1,
        }],
      ),
    );
    return Promise.resolve(Response.json({
      chart: {
        error: null,
        result: [{
          meta: { currency: "USD", exchangeTimezoneName: "America/New_York" },
          timestamp,
          indicators: { quote: [{ close }] },
          events: { splits },
        }],
      },
    }));
  };
}

Deno.test("Yahoo range coverage finds only missing prefixes, interior gaps and tails", () => {
  deepStrictEqual(
    missingRanges("2025-01-01", "2025-01-10", [
      { start: "2025-01-03", end: "2025-01-05" },
      { start: "2025-01-04", end: "2025-01-06" },
      { start: "2025-01-08", end: "2025-01-09" },
    ]),
    [{ start: "2025-01-01", end: "2025-01-03" }, {
      start: "2025-01-06",
      end: "2025-01-08",
    }, { start: "2025-01-09", end: "2025-01-10" }],
  );
  deepStrictEqual(
    missingRanges("2025-01-03", "2025-01-04", [{
      start: "2025-01-01",
      end: "2025-01-10",
    }]),
    [],
  );
});

Deno.test("persistent Yahoo cache survives restart, coalesces readers and extends only missing history", async () => {
  const db = new Database(":memory:");
  const calls: URL[] = [];
  let now = new Date("2025-01-10T20:00:00Z");
  try {
    const request = market([], calls);
    let cache = new YahooHistoryCache(db, request, () => now);
    const [a, b] = await Promise.all([
      cache.get("AAPL", "2025-01-01"),
      cache.get("AAPL", "2025-01-01"),
    ]);
    deepStrictEqual(a, b);
    equal(calls.length, 2);
    cache = new YahooHistoryCache(db, request, () => now);
    deepStrictEqual(await cache.get("AAPL", "2025-01-01"), a);
    equal(calls.length, 2);
    now = new Date("2025-01-11T20:00:00Z");
    await cache.get("AAPL", "2025-01-01");
    equal(calls.length, 4);
    equal(
      calls[3].searchParams.get("period1"),
      String(Date.parse("2025-01-08") / 1000),
    );
    equal(
      calls[3].searchParams.get("period2"),
      String(Date.parse("2025-01-09") / 1000),
    );
    await cache.get("AAPL", "2024-12-28");
    equal(calls.length, 5);
    equal(
      calls[4].searchParams.get("period2"),
      String(Date.parse("2025-01-01") / 1000),
    );
    ok(calls.every((url) => url.searchParams.get("interval") === "1d"));
  } finally {
    db.close();
  }
});

Deno.test("empty holidays and weekends remain covered; failed fetches are never marked covered", async () => {
  const db = new Database(":memory:");
  const calls: URL[] = [];
  try {
    const now = () => new Date("2025-01-10T12:00:00Z");
    const cache = new YahooHistoryCache(db, market([], calls, true), now);
    await cache.get("CLOSED", "2025-01-01");
    await cache.get("CLOSED", "2025-01-01");
    equal(calls.length, 2);
    const failing = new YahooHistoryCache(
      db,
      () => Promise.resolve(new Response(null, { status: 429 })),
      now,
    );
    await rejects(failing.get("BAD", "2025-01-01"), /HTTP 429/);
    equal(
      (db.prepare(
        "SELECT COUNT(*) AS count FROM yahoo_coverage WHERE symbol='BAD'",
      ).get() as { count: number }).count,
      0,
    );
  } finally {
    db.close();
  }
});

Deno.test("Yahoo split-adjusted closes become immutable raw closes, including splits in the recent tail", async () => {
  const db = new Database(":memory:");
  const calls: URL[] = [];
  let now = new Date("2025-01-10T20:00:00Z");
  const splits: StockSplit[] = [{ date: "2025-01-09", ratio: 2 }];
  try {
    const cache = new YahooHistoryCache(db, market(splits, calls), () => now);
    const first = await cache.get("SPLIT", "2025-01-01");
    equal(first.bars[0].close, 100);
    equal(first.splits[0].ratio, 2);
    splits.push({ date: "2025-01-11", ratio: 3 });
    now = new Date("2025-01-14T20:00:00Z");
    const next = await cache.get("SPLIT", "2025-01-01");
    equal(next.bars[0].close, 100);
    equal(next.splits.length, 2);
    // The prefix fetch sees current split-adjusted prices and all cached future splits.
    const expanded = await cache.get("SPLIT", "2024-12-30");
    equal(expanded.bars[0].close, 100);
    equal(
      calls.filter((url) =>
        url.searchParams.get("period1") ===
          String(Date.parse("2025-01-01") / 1000)
      ).length,
      1,
    );
  } finally {
    db.close();
  }
});

Deno.test("Yahoo treats GBp as pence, aligns exchange dates and rejects malformed bars", async () => {
  equal(quoteCurrency("GBp"), "GBX");
  equal(quoteCurrency("GBP"), "GBP");
  const data = {
    chart: {
      result: [{
        meta: { currency: "GBp", exchangeTimezoneName: "Asia/Tokyo" },
        timestamp: [Date.parse("2025-01-02T23:00:00Z") / 1000],
        indicators: { quote: [{ close: [500] }] },
      }],
      error: null,
    },
  };
  const history = await fetchYahooHistory(
    "UK",
    "2025-01-01",
    "2025-01-05",
    () => Promise.resolve(Response.json(data)),
  );
  equal(history.currency, "GBX");
  equal(history.bars[0].date, "2025-01-03");
  data.chart.result[0].indicators.quote[0].close[0] = -1;
  await rejects(
    fetchYahooHistory(
      "UK",
      "2025-01-01",
      "2025-01-05",
      () => Promise.resolve(Response.json(data)),
    ),
    /Invalid historical price/,
  );
});

Deno.test("symbol resolution rejects recent lookalike listings and reuses a historical ISIN match", async () => {
  const db = new Database(":memory:");
  const calls: URL[] = [];
  const request: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    calls.push(url);
    if (url.pathname.includes("/search")) {
      return Response.json({
        quotes: [{ symbol: "SMSN.IL", quoteType: "EQUITY" }],
      });
    }
    const data = await (await market()(input, init)).json();
    if (url.pathname.endsWith("SMSN.L")) {
      const result = data.chart.result[0];
      const pairs = result.timestamp.map((
        t: number,
        i: number,
      ) => [t, result.indicators.quote[0].close[i]])
        .filter(([t]: number[]) => t >= Date.parse("2025-01-08") / 1000);
      result.timestamp = pairs.map(([t]: number[]) => t);
      result.indicators.quote[0].close = pairs.map(([, close]: number[]) =>
        close
      );
    }
    return Response.json(data);
  };
  try {
    const cache = new YahooHistoryCache(
      db,
      request,
      () => new Date("2025-01-10T20:00:00Z"),
    );
    const instrument = {
      ticker: "SMSNL_EQ",
      currency: "USD",
      yahooSymbol: "SMSN.L",
      isin: "US7960508882",
    };
    // Even a previously resolved recent listing must cover the actual purchase.
    db.prepare("INSERT INTO yahoo_symbols(source_key,symbol) VALUES (?,?)").run(
      JSON.stringify([
        "SMSNL_EQ",
        "USD",
        instrument.isin,
        instrument.yahooSymbol,
      ]),
      "SMSN.L",
    );
    equal(await cache.resolve(instrument, "2025-01-02"), "SMSN.IL");
    const count = calls.length;
    equal(await cache.resolve(instrument, "2025-01-02"), "SMSN.IL");
    equal(calls.length, count);
    ok(calls.some((url) => url.pathname.endsWith("SMSN.IL")));
  } finally {
    db.close();
  }
});

Deno.test("explicit symbol overrides replace cached defaults and never silently fall back", async () => {
  const original = Deno.env.get("EYRI_YAHOO_SYMBOLS");
  const db = new Database(":memory:");
  const calls: URL[] = [];
  const request: typeof fetch = (input, init) => {
    if (String(input).includes("/BROKEN?")) {
      return Promise.resolve(new Response(null, { status: 404 }));
    }
    return market([], calls)(input, init);
  };
  try {
    Deno.env.delete("EYRI_YAHOO_SYMBOLS");
    const cache = new YahooHistoryCache(
      db,
      request,
      () => new Date("2025-01-10T20:00:00Z"),
    );
    const instrument = { ticker: "AAPL", currency: "USD" };
    equal(await cache.resolve(instrument), "AAPL");
    Deno.env.set(
      "EYRI_YAHOO_SYMBOLS",
      JSON.stringify({ "AAPL:USD": "CUSTOM" }),
    );
    equal(await cache.resolve(instrument), "CUSTOM");
    const count = calls.length;
    equal(await cache.resolve(instrument), "CUSTOM");
    equal(calls.length, count);
    Deno.env.set(
      "EYRI_YAHOO_SYMBOLS",
      JSON.stringify({ "AAPL:USD": "BROKEN" }),
    );
    await rejects(
      cache.resolve(instrument),
      /Cannot resolve historical prices/,
    );
    equal(calls.length, count);
    Deno.env.set("EYRI_YAHOO_SYMBOLS", JSON.stringify({ "AAPL:USD": "" }));
    await rejects(
      cache.resolve(instrument),
      /Invalid EYRI_YAHOO_SYMBOLS override/,
    );
  } finally {
    if (original === undefined) Deno.env.delete("EYRI_YAHOO_SYMBOLS");
    else Deno.env.set("EYRI_YAHOO_SYMBOLS", original);
    db.close();
  }
});

Deno.test("Freedom24 and IBKR symbol defaults resolve through Yahoo and reuse persistent history", async () => {
  const db = new Database(":memory:");
  const calls: URL[] = [];
  const request: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const symbol = decodeURIComponent(url.pathname.split("/").at(-1)!);
    if (!["CRDO", "BRK-B", "VOD.L"].includes(symbol)) {
      throw new Error(`Unexpected Yahoo symbol ${symbol}`);
    }
    const data = await (await market([], calls)(input, init)).json();
    if (symbol === "VOD.L") data.chart.result[0].meta.currency = "GBp";
    return Response.json(data);
  };
  try {
    const clock = () => new Date("2025-01-10T20:00:00Z");
    const instruments = [
      { ticker: "CRDO.US", currency: "USD" },
      { ticker: "BRK B", currency: "USD" },
      { ticker: "VOD", currency: "GBP" },
    ];
    let cache = new YahooHistoryCache(db, request, clock);
    for (const [index, instrument] of instruments.entries()) {
      equal(
        await cache.resolve(instrument, "2025-01-02"),
        ["CRDO", "BRK-B", "VOD.L"][index],
      );
    }
    const count = calls.length;
    cache = new YahooHistoryCache(db, request, clock);
    for (const instrument of instruments) {
      await cache.resolve(instrument, "2025-01-02");
    }
    equal(calls.length, count);
  } finally {
    db.close();
  }
});
