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
  IntegrationOrder,
  IntegrationPortfolioPosition,
} from "../integrations/types.ts";
import type { PriceHistory } from "../market_data/yahoo.ts";
import {
  type AllTimeDataset,
  buildAllTimeSeries,
  instrumentKey,
  loadAllTimeDataset,
  renderAllTimeChart,
} from "./alltime_chart.ts";
import {
  buildIntegratedAllTimePerformanceList,
  getOrderTransactionKey,
} from "./portfolio.ts";

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

Deno.test("all-time series replays purchases and FIFO sales, carries weekends, and ends at /alltime", async () => {
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
    series.map((p) => [p.date, p.gain, Number(p.percentage.toFixed(8))]),
    [
      ["2025-01-01", 0, 0],
      ["2025-01-02", 0, 0],
      ["2025-01-03", 140, 14],
      ["2025-01-04", 140, 14],
      ["2025-01-05", 140, 14],
      ["2025-01-06", 260, 26],
    ],
  );
  const text = await buildIntegratedAllTimePerformanceList({
    ...args,
    formatTicker: (t) => t,
  });
  match(text, /Total: \+26\.00% \+\$260\.00/);
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
  ok(Math.abs(points.at(-1)!.percentage + 20 / 300 * 100) < 1e-9);
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
  equal(core.at(-1)!.percentage, 200);
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
  ok(Math.abs(rest.at(-1)!.percentage - 350 / 1200 * 100) < 1e-9);
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
  equal(points[1].percentage, 10);
  equal(points.at(-1)!.gain, 4);
  equal(points.at(-1)!.percentage, 20);
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
  equal(points.at(-1)!.percentage, 20);
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
  throws(
    () => buildAllTimeSeries({ ...base, orders: [] }, histories, rates),
    /purchase history/,
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
    /does not reconcile/,
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
    const other: AllTimeDataset = {
      ...first,
      userId: 2,
      label: "Other",
      points: first.points.map((p) => ({
        ...p,
        percentage: -p.percentage / 2,
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
        match(error.message, /BAD1 \(USD\).*No matching listing/);
        match(error.message, /BAD2 \(USD\).*429/);
        match(error.message, /EMPTY \(USD\).*No historical closing prices/);
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
