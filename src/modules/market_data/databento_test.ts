import {
  deepStrictEqual,
  equal,
  ok,
  rejects,
  throws,
} from "node:assert/strict";
import { Database } from "@db/sqlite";
import {
  DatabentoHistoryCache,
  databentoOptionSymbol,
  fetchDatabentoOptionHistory,
} from "./databento.ts";
import { dayAfter } from "./history.ts";
import { YahooHistoryCache } from "./yahoo.ts";

const SYMBOL = "BOTZ240315C00033000";
const RAW = "BOTZ  240315C00033000";
const now = () => new Date("2024-04-01T20:00:00Z");
const ns = (date: string) => String(BigInt(Date.parse(date)) * 1_000_000n);
function trade(date: string, price: number, received = date, symbol = RAW) {
  return {
    hd: { rtype: 0, ts_event: ns(date), publisher_id: 21 },
    ts_recv: ns(received),
    action: "T",
    symbol,
    price: price.toFixed(9),
  };
}
function lines(records: unknown[]) {
  return records.map((r) => JSON.stringify(r)).join("\n");
}
function archive(
  calls: { method: string; params: URLSearchParams }[],
  fail = false,
  empty = false,
): typeof fetch {
  return (input, init) => {
    const url = new URL(String(input));
    if (url.hostname === "query1.finance.yahoo.com") {
      return Promise.resolve(new Response(null, { status: 404 }));
    }
    equal(url.hostname, "hist.databento.com");
    const method = url.pathname.split("/").at(-1)!;
    const params = init?.method === "POST"
      ? new URLSearchParams(String(init.body))
      : url.searchParams;
    calls.push({ method, params });
    equal(
      new Headers(init?.headers).get("Authorization"),
      "Basic " + btoa("test-key:"),
    );
    if (method === "metadata.get_dataset_range") {
      return Promise.resolve(Response.json({
        schema: {
          trades: {
            start: "2013-04-01T00:00:00Z",
            end: "2024-04-01T13:30:00Z",
          },
        },
      }));
    }
    if (fail) return Promise.resolve(new Response(null, { status: 429 }));
    equal(params.get("schema"), "trades");
    equal(params.get("symbols"), RAW);
    const records: unknown[] = [];
    for (
      let date = params.get("start")!;
      date < params.get("end")!;
      date = dayAfter(date)
    ) {
      if (!empty) records.push(trade(date + "T20:00:00Z", 0.1));
    }
    return Promise.resolve(new Response(lines(records)));
  };
}

Deno.test("Databento uses padded OCC symbols and refuses equity requests", async () => {
  equal(databentoOptionSymbol("+BOTZ.15MAR2024.C33"), RAW);
  equal(databentoOptionSymbol("MU260626P00850000"), "MU    260626P00850000");
  throws(() => databentoOptionSymbol("BOTZ"), /only supports option/);
  const db = new Database(":memory:");
  try {
    const cache = new DatabentoHistoryCache(
      db,
      () => {
        throw new Error("Must never fetch a stock");
      },
      now,
      () => "test-key",
    );
    await rejects(cache.get("AAPL", "2024-01-01"), /only supports option/);
  } finally {
    db.close();
  }
});

Deno.test("Databento streams trades into last session closes across venues, including zero premiums", async () => {
  const data = lines([
    trade("2024-02-08T21:00:00Z", 0.2),
    trade("2024-02-08T20:00:00Z", 0.1),
    trade("2024-02-10T00:01:00Z", 0), // Still February 9 in New York.
    trade("2024-02-08T21:00:00Z", 0.3, "2024-02-08T21:00:01Z"),
  ]);
  const encoded = new TextEncoder().encode(data);
  const request: typeof fetch = () =>
    Promise.resolve(
      new Response(
        new ReadableStream({
          start(controller) {
            // Split JSON records and newline boundaries across arbitrary network chunks.
            for (let i = 0; i < encoded.length; i += 23) {
              controller.enqueue(encoded.slice(i, i + 23));
            }
            controller.close();
          },
        }),
      ),
    );
  const result = await fetchDatabentoOptionHistory(
    SYMBOL,
    "2024-02-08",
    "2024-02-10",
    "test-key",
    request,
  );
  deepStrictEqual(result.bars, [{ date: "2024-02-08", close: 0.3 }, {
    date: "2024-02-09",
    close: 0,
  }]);
  equal(result.currency, "USD");
  equal(result.instrumentType, "OPTION");
});

Deno.test("Databento rejects mismatched contracts, malformed prices, truncated streams and API failures", async () => {
  for (
    const record of [
      trade("2024-02-08T20:00:00Z", 1, undefined, "AMD   240315C00033000"),
      { ...trade("2024-02-08T20:00:00Z", 1), price: "NaN" },
      { ...trade("2024-02-08T20:00:00Z", 1), price: null },
    ]
  ) {
    await rejects(
      fetchDatabentoOptionHistory(
        SYMBOL,
        "2024-02-01",
        "2024-03-16",
        "test-key",
        () => Promise.resolve(new Response(lines([record]))),
      ),
    );
  }
  await rejects(
    fetchDatabentoOptionHistory(
      SYMBOL,
      "2024-02-01",
      "2024-03-16",
      "test-key",
      () => Promise.resolve(new Response('{"hd":')),
    ),
  );
  await rejects(
    fetchDatabentoOptionHistory(
      SYMBOL,
      "2024-02-01",
      "2024-03-16",
      "test-key",
      () => Promise.resolve(new Response(null, { status: 401 })),
    ),
    /HTTP 401/,
  );
});

Deno.test("expired Databento backfills coalesce, survive restart without a key and extend only uncovered ranges", async () => {
  const db = new Database(":memory:");
  const calls: { method: string; params: URLSearchParams }[] = [];
  try {
    let cache = new DatabentoHistoryCache(
      db,
      archive(calls),
      now,
      () => "test-key",
    );
    const [a, b] = await Promise.all([
      cache.get(SYMBOL, "2024-02-01"),
      cache.get(SYMBOL, "2024-02-01"),
    ]);
    deepStrictEqual(a, b);
    equal(calls.filter((c) => c.method === "timeseries.get_range").length, 2);
    equal(calls.at(-1)!.params.get("end"), "2024-03-16");
    const count = calls.length;
    cache = new DatabentoHistoryCache(db, archive(calls), now, () => undefined);
    deepStrictEqual(await cache.get(SYMBOL, "2024-02-01"), a);
    equal(calls.length, count);
    cache = new DatabentoHistoryCache(
      db,
      archive(calls),
      now,
      () => "test-key",
    );
    await cache.get(SYMBOL, "2024-01-28");
    equal(calls.at(-1)!.params.get("start"), "2024-01-28");
    equal(calls.at(-1)!.params.get("end"), "2024-02-01");
  } finally {
    db.close();
  }
});

Deno.test("Databento covers empty sessions, never covers failures, and caps requests at sale, expiry and finalized availability", async () => {
  const db = new Database(":memory:");
  const calls: { method: string; params: URLSearchParams }[] = [];
  try {
    const empty = new DatabentoHistoryCache(
      db,
      archive(calls, false, true),
      now,
      () => "test-key",
    );
    await empty.get(SYMBOL, "2024-02-01", "2024-02-05");
    const count = calls.length;
    await empty.get(SYMBOL, "2024-02-01", "2024-02-05");
    equal(calls.length, count);
    equal(calls.at(-1)!.params.get("end"), "2024-02-05");
    const failing = new DatabentoHistoryCache(
      db,
      archive(calls, true),
      now,
      () => "test-key",
    );
    await rejects(failing.get(SYMBOL, "2024-01-01", "2024-02-01"), /HTTP 429/);
    equal(
      (db.prepare(
        "SELECT COUNT(*) AS n FROM databento_option_coverage WHERE start='2024-01-01'",
      ).get() as { n: number }).n,
      0,
    );
    // The provider has only part of April 1. Do not persist that day's partial marks.
    const liveRequest: typeof fetch = (input, init) => {
      if (String(input).includes("timeseries.get_range")) {
        calls.push({
          method: "timeseries.get_range",
          params: new URLSearchParams(String(init?.body)),
        });
        return Promise.resolve(new Response(""));
      }
      return archive(calls)(input, init);
    };
    const live = new DatabentoHistoryCache(
      db,
      liveRequest,
      () => new Date("2024-04-03T20:00:00Z"),
      () => "test-key",
    );
    await live.get("AMD270115C00280000", "2024-03-30");
    equal(calls.at(-1)!.params.get("end"), "2024-04-01");
  } finally {
    db.close();
  }
});

Deno.test("Yahoo falls back for missing options and reuses the archive after restart; stocks never use Databento", async () => {
  const db = new Database(":memory:");
  const calls: { method: string; params: URLSearchParams }[] = [];
  let yahooCalls = 0;
  const request: typeof fetch = (input, init) => {
    if (String(input).includes("finance.yahoo.com")) yahooCalls++;
    return archive(calls)(input, init);
  };
  try {
    let fallback = new DatabentoHistoryCache(
      db,
      request,
      now,
      () => "test-key",
    );
    let cache = new YahooHistoryCache(db, request, now, fallback);
    const instrument = { ticker: "+BOTZ.15MAR2024.C33", currency: "USD" };
    const symbol = await cache.resolve(
      instrument,
      "2024-02-08",
      1,
      "2024-02-20",
    );
    const data = await cache.get(symbol, "2024-02-01", "2024-02-20");
    ok(data.bars.length);
    ok(yahooCalls > 0);
    const count = calls.length, yahooCount = yahooCalls;
    fallback = new DatabentoHistoryCache(db, request, now, () => undefined);
    cache = new YahooHistoryCache(db, request, now, fallback);
    equal(
      await cache.resolve(instrument, "2024-02-08", 1, "2024-02-20"),
      symbol,
    );
    deepStrictEqual(await cache.get(symbol, "2024-02-01", "2024-02-20"), data);
    equal(calls.length, count);
    equal(yahooCalls, yahooCount);
    fallback = new DatabentoHistoryCache(db, request, now, () => "test-key");
    cache = new YahooHistoryCache(db, request, now, fallback);
    await rejects(
      cache.resolve({ ticker: "VSCO.US", currency: "USD" }, "2024-02-08"),
    );
    equal(calls.length, count);
    const { saveYahooMapping } = await import("./mappings.ts");
    saveYahooMapping(db, 1, "VSCO.US", SYMBOL);
    await rejects(
      cache.resolve({ ticker: "VSCO.US", currency: "USD" }, "2024-02-08", 1),
    );
    equal(calls.length, count);
  } finally {
    db.close();
  }
});

Deno.test("successful Yahoo option history never calls Databento; an explicit stock mapping cannot invoke the fallback", async () => {
  const { saveYahooMapping } = await import("./mappings.ts");
  const db = new Database(":memory:");
  let paidCalls = 0;
  const request: typeof fetch = (input) => {
    const url = new URL(String(input));
    if (!url.hostname.includes("yahoo.com")) {
      paidCalls++;
      throw new Error("Unexpected archive request");
    }
    const stock = url.pathname.endsWith("/AMD");
    return Promise.resolve(Response.json({
      chart: {
        result: [{
          meta: {
            currency: "USD",
            exchangeTimezoneName: "America/New_York",
            instrumentType: stock ? "EQUITY" : "OPTION",
          },
          timestamp: [Date.parse("2024-02-01T20:00:00Z") / 1000],
          indicators: { quote: [{ close: [0.1] }] },
        }],
      },
    }));
  };
  try {
    const fallback = new DatabentoHistoryCache(
      db,
      request,
      now,
      () => "test-key",
    );
    const cache = new YahooHistoryCache(db, request, now, fallback);
    equal(
      await cache.resolve(
        { ticker: "+BOTZ.15MAR2024.C33", currency: "USD" },
        "2024-02-08",
      ),
      SYMBOL,
    );
    equal(paidCalls, 0);
    saveYahooMapping(db, 1, "+AMD.15JAN2027.C280", "AMD");
    await rejects(
      cache.resolve(
        { ticker: "+AMD.15JAN2027.C280", currency: "USD" },
        "2024-02-08",
        1,
      ),
    );
    equal(paidCalls, 0);
  } finally {
    db.close();
  }
});

Deno.test("live Databento caches fetch only newly finalized days and leave older closes immutable", async () => {
  const db = new Database(":memory:");
  let current = new Date("2024-02-05T20:00:00Z");
  let availableEnd = "2024-02-04";
  let premium = 0.1;
  const ranges: string[][] = [];
  const request: typeof fetch = (input, init) => {
    if (String(input).includes("metadata.get_dataset_range")) {
      return Promise.resolve(Response.json({
        schema: {
          trades: {
            start: "2013-04-01T00:00:00Z",
            end: availableEnd + "T13:30:00Z",
          },
        },
      }));
    }
    const params = new URLSearchParams(String(init?.body));
    const start = params.get("start")!, end = params.get("end")!;
    ranges.push([start, end]);
    const records: unknown[] = [];
    for (let date = start; date < end; date = dayAfter(date)) {
      records.push(trade(date + "T20:00:00Z", premium));
    }
    return Promise.resolve(new Response(lines(records)));
  };
  try {
    const cache = new DatabentoHistoryCache(
      db,
      request,
      () => current,
      () => "test-key",
    );
    await cache.get(SYMBOL, "2024-02-01");
    await cache.get(SYMBOL, "2024-02-01");
    equal(ranges.length, 1);
    current = new Date("2024-02-07T20:00:00Z");
    availableEnd = "2024-02-06";
    premium = 0.2;
    const history = await cache.get(SYMBOL, "2024-02-01");
    deepStrictEqual(ranges, [["2024-02-01", "2024-02-04"], [
      "2024-02-04",
      "2024-02-06",
    ]]);
    equal(history.bars[0].close, 0.1);
    equal(history.bars.at(-1)!.close, 0.2);
    equal(history.bars.at(-1)!.date, "2024-02-05");
  } finally {
    db.close();
  }
});
