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

Deno.test("live chart endpoint uses FX-inclusive broker valuation and agrees with alltime", async () => {
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
  equal(points.at(-1)!.percentage, 27.99 / 170 * 100);
  const text = await buildIntegratedAllTimePerformanceList({
    ...args,
    request: async () => Response.json({ base: "USD", quote: "EUR", rate: .8 }),
    formatTicker: (ticker) => ticker,
  });
  match(text, /Total: \+16\.46% \+\$34\.99/);
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
      ok(Math.abs(point.percentage - nativeGain / (1142 * .49) * 100) < 1e-9);
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

Deno.test("Freedom24 option series uses per-contract premiums, retains sold gains and ends at alltime", async () => {
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
  equal(points.at(-1)!.percentage, 40);
  match(
    await buildIntegratedAllTimePerformanceList({
      ...args,
      formatTicker: (t) => t,
    }),
    /Total: \+40.00% \+\$80.00/,
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
    equal(dataset.points.at(-1)!.percentage, 75);
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
    equal(dataset.points.at(-1)!.percentage, 50);
    const text = await buildIntegratedAllTimePerformanceList({
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
    match(text, /Total: \+50\.00% \+\$300\.00/);
  } finally {
    db.close();
  }
});

Deno.test("a current holding with no purchase is a history error, not a Yahoo mapping suggestion", async () => {
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
