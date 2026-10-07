import { deepStrictEqual, equal, match, ok, rejects } from "node:assert/strict";
import type { Integration } from "../../database/integration.ts";
import type { Database } from "../../database/setup.ts";
import {
  buildBucketedPortfolioPositions,
  buildIntegratedDailyPerformanceList,
  buildIntegratedPerformanceList,
  buildIntegratedTickerList,
  getOrderTransactionKey,
} from "../../tickers/portfolio.ts";
import { freedom24Adapter } from "./adapter.ts";
import type {
  Freedom24Order,
  Freedom24PortfolioPosition,
  Freedom24Quote,
} from "./api.ts";

const integration: Integration = {
  id: 1,
  userId: 1,
  kind: "f24",
  createdAt: new Date(),
  updatedAt: new Date(),
  credentials: { apiKey: "test", secretKey: "test" },
};
function required<T>(value: T | null | undefined): T {
  ok(value !== null && value !== undefined);
  return value;
}
const db = null as unknown as Database;
const today = "2026-10-06T10:01:00";

async function withApi(
  positions: Freedom24PortfolioPosition[],
  quotes: Freedom24Quote[],
  run: () => Promise<void>,
) {
  const fetch = globalThis.fetch;
  const now = Date.now;
  Date.now = () => Date.parse("2026-10-06T14:01:00Z");
  globalThis.fetch = (input, init) => {
    const command = String(input).split("/").at(-1);
    equal(new URLSearchParams(String(init?.body)).get("apiKey"), "test");
    const body = command === "getPositionJson"
      ? { result: { ps: { pos: positions } } }
      : command === "getOrdersHistory"
      ? {
        orders: {
          order: [
            {
              instr: "VSCO.US",
              date: "2026-06-01T21:55:14",
              stat: 21,
              oper: 1,
              q: 1,
              p: 55.29,
            },
            {
              instr: "+APH.15JAN2027.C200",
              date: "2026-06-03T16:30:18",
              stat: 21,
              oper: 1,
              q: 1,
              p: 1086,
            },
          ],
        },
      }
      : { result: { q: quotes } };
    return Promise.resolve(new Response(JSON.stringify(body)));
  };
  try {
    await run();
  } finally {
    globalThis.fetch = fetch;
    Date.now = now;
  }
}

Deno.test("Freedom24 uses broker book cost and daily close P&L, not quote history", async () => {
  await withApi(
    [
      {
        i: "CRDO.US",
        q: 4,
        price_a: 220.98475,
        s: 883.95,
        fv: 100,
        profit_close: -39.43,
      },
      {
        i: "+SMCI.15JAN2027.C50",
        q: 5,
        price_a: 4.451999,
        s: 2226,
        fv: 10000,
        profit_close: -36,
      },
      {
        i: "VEEV.US",
        q: 1,
        price_a: 187.78,
        s: 187.78,
        fv: 100,
        profit_close: 89.57,
      },
    ],
    [
      {
        c: "CRDO.US",
        bbp: 223.62,
        ltp: 223.8,
        ClosePrice: 212.48,
        pp: 218.64,
        p5: 193.81,
        marketStatus: "OPEN",
        ltt: today,
        UTCOffset: -240,
      },
      {
        c: "+SMCI.15JAN2027.C50",
        bbp: 4.85,
        ltp: 4.9,
        ClosePrice: 0,
        pp: 0,
        p5: 4.6,
        marketStatus: "OPEN",
        ltt: today,
        UTCOffset: -240,
      },
      {
        c: "VEEV.US",
        bbp: 285.52,
        marketStatus: "OPEN",
        ltt: today,
        UTCOffset: -240,
      },
    ],
    async () => {
      const positions = await freedom24Adapter.fetchPortfolio(db, integration);
      const credo = required(positions.find((p) => p.ticker === "CRDO.US"));
      equal(credo.totalInput, 883.95);
      equal(credo.totalNow, 894.48);
      ok(Math.abs(required(credo.dailyPnl) - 49.96) < 1e-9);
      ok(Math.abs(required(credo.unrealizedPnl) - 10.53) < 1e-9);
      equal(credo.realizedPnl, null);
      const option = required(positions.find((p) => p.ticker.startsWith("+")));
      ok(Math.abs(required(option.dailyPnl) - 235) < 1e-9);
      equal(option.dailyPnlBaseline, 2190);
      const output = await buildIntegratedDailyPerformanceList({ positions });
      match(output, /CRDO.US.*\+5.92% \+\$49.96 today/);
      match(output, /VEEV.US.*\+2.95% \+\$8.17 today/);
      match(output, /Total: \+8.13% \+\$293.13 today/);
    },
  );
});

Deno.test("Freedom24 shows adjusted live holdings and zero daily movement for stale options", async () => {
  await withApi(
    [
      {
        i: "VSXY.US",
        q: 1,
        price_a: 55.29,
        s: 55.29,
        fv: 100,
        profit_close: 33.41,
      },
      {
        i: "+APH.15JAN2027.C100",
        q: 2,
        price_a: 5.43,
        s: 1086,
        fv: "10000",
        profit_close: -368,
      },
      {
        i: "+ETN.15JAN2027.C600",
        q: 1,
        price_a: 11.87,
        s: 1187,
        fv: 10000,
        profit_close: -907,
      },
    ],
    [
      {
        c: "VSXY.US",
        bbp: 88.45,
        marketStatus: "OPEN",
        ltt: today,
        UTCOffset: -240,
      },
      {
        c: "+APH.15JAN2027.C100",
        bbp: 3.5,
        marketStatus: "OPEN",
        ltt: "2026-10-05T14:34:17",
        UTCOffset: -240,
        p5: 3.1,
      },
      {
        c: "+ETN.15JAN2027.C600",
        bbp: 0.95,
        marketStatus: "OPEN",
        ltt: "2026-10-05T14:00:00",
        UTCOffset: -240,
        p5: 2.62,
      },
    ],
    async () => {
      const livePositions = await freedom24Adapter.fetchPortfolio(
        db,
        integration,
      );
      const orders = await freedom24Adapter.fetchOrderHistory(db, integration);
      const positions = buildBucketedPortfolioPositions({
        livePositions,
        orders,
        transactionBuckets: new Map(),
        bucketName: null,
      });
      equal(positions.length, 3);
      ok(
        !positions.some(
          (p) => p.ticker.includes("VSCO") || p.ticker.endsWith("C200"),
        ),
      );
      const aph = required(positions.find((p) => p.ticker.includes("APH")));
      equal(aph.amount, 2);
      equal(aph.averageUnitPrice, 543);
      equal(aph.totalNow, 700);
      equal(aph.unrealizedPnl, -386);
      equal(aph.dailyPnl, 0);
      equal(aph.dailyPnlPercentage, 0);
      equal(
        required(positions.find((p) => p.ticker.includes("ETN"))).dailyPnl,
        0,
      );
      for (
        const render of [
          buildIntegratedDailyPerformanceList,
          buildIntegratedPerformanceList,
        ]
      ) {
        const output = await render({ positions });
        ok(!output.includes("? ?"), output);
      }
      const detail = await buildIntegratedTickerList({ positions });
      match(detail, /-35.54%/);
      match(required(detail.split("\n\n").at(-1)), /^-\$1,444.84 -62.06%/);
    },
  );
});

Deno.test("Freedom24 falls back to position price and ignores unrelated quote responses", async () => {
  await withApi(
    [
      {
        i: "MISSING.US",
        q: 2,
        price_a: 10,
        mkt_price: 11,
        fv: 100,
        profit_close: 1,
      },
    ],
    [{ c: "UNRELATED.US", bbp: 999, marketStatus: "OPEN" }],
    async () => {
      const [position] = await freedom24Adapter.fetchPortfolio(db, integration);
      equal(position.currentPrice, 11);
      equal(position.totalInput, 20);
      equal(position.dailyPnl, 1);
    },
  );
});

Deno.test("unbucketed live holdings retain corporate actions while bucket quantities and cost reconcile", async () => {
  await withApi(
    [
      {
        i: "CRDO.US",
        q: 4,
        price_a: 220.98475,
        s: 883.95,
        fv: 100,
        profit_close: -39.43,
      },
      {
        i: "VSXY.US",
        q: 1,
        price_a: 55.29,
        s: 55.29,
        fv: 100,
        profit_close: 33.41,
      },
    ],
    [
      {
        c: "CRDO.US",
        bbp: 223.62,
        marketStatus: "OPEN",
        ltt: today,
        UTCOffset: -240,
      },
      {
        c: "VSXY.US",
        bbp: 88.45,
        marketStatus: "OPEN",
        ltt: today,
        UTCOffset: -240,
      },
    ],
    async () => {
      const livePositions = await freedom24Adapter.fetchPortfolio(
        db,
        integration,
      );
      const order = {
        integrationId: 1,
        integrationKind: "f24",
        account: "Freedom24",
        ticker: "CRDO.US",
        currency: "USD",
        quantity: 1,
        price: 200,
        date: new Date("2026-06-01T12:00:00Z"),
        assetCategory: null,
      };
      const transactionBuckets = new Map([
        [getOrderTransactionKey(order), "LongTerm"],
      ]);
      const args = { orders: [order], livePositions, transactionBuckets };
      const bucket = buildBucketedPortfolioPositions({
        ...args,
        bucketName: "LongTerm",
      });
      const unbucketed = buildBucketedPortfolioPositions({
        ...args,
        bucketName: null,
      });
      const credo = required(unbucketed.find((p) => p.ticker === "CRDO.US"));
      equal(credo.amount, 3);
      equal(credo.totalInput, 683.95);
      ok(Math.abs(required(credo.dailyPnl) - 37.47) < 1e-9);
      equal(
        required(bucket[0].totalInput) + required(credo.totalInput),
        883.95,
      );
      deepStrictEqual(unbucketed.map((p) => p.ticker).sort(), [
        "CRDO.US",
        "VSXY.US",
      ]);
    },
  );
});

Deno.test("Freedom24 values short positions at the ask and uses the exchange date across midnight UTC", async () => {
  await withApi(
    [{ i: "SHORT.US", q: -2, price_a: 12, s: -24, fv: 100, profit_close: 2 }],
    [
      {
        c: "SHORT.US",
        bbp: 9,
        bap: 10,
        ltp: 9.5,
        marketStatus: "OPEN",
        ltt: "2026-10-05T23:59:00",
        UTCOffset: -240,
      },
    ],
    async () => {
      Date.now = () => Date.parse("2026-10-06T02:00:00Z");
      const [position] = await freedom24Adapter.fetchPortfolio(db, integration);
      equal(position.currentPrice, 10);
      equal(position.totalNow, -20);
      equal(position.dailyPnl, 2);
    },
  );
});

async function withHistory(
  response: (body: URLSearchParams) => unknown,
  run: () => Promise<void>,
) {
  const original = globalThis.fetch;
  globalThis.fetch = (_input, init) =>
    Promise.resolve(
      Response.json(response(new URLSearchParams(String(init?.body)))),
    );
  try {
    await run();
  } finally {
    globalThis.fetch = original;
  }
}

Deno.test("Freedom24 imports BOTZ partial and cancelled fills at execution times, including margin purchases", async () => {
  const ticker = "+BOTZ.15MAR2024.C33";
  const rows = [
    {
      id: 1,
      instr: ticker,
      stat: 30,
      oper: 1,
      q: 10,
      p: 999,
      trade: [
        { id: "buy1", date: "2024-02-08T10:00:00Z", q: "1", v: "10" },
      ],
    },
    {
      id: 2,
      instr: ticker,
      stat: "21",
      oper: "2",
      q: "1",
      trade: [
        { id: "buy2", date: "2024-02-09T12:00:00Z", q: "1", v: "20" },
      ],
    },
    {
      id: 3,
      instr: ticker,
      stat: 21,
      oper: 3,
      q: 2,
      trade: [
        { id: "sell1", date: "2024-02-08T11:00:00Z", q: 1, v: 15 },
        { id: "sell2", date: "2024-02-09T13:00:00Z", q: 1, v: 25 },
      ],
    },
    { id: 4, instr: ticker, stat: 31, oper: 1, q: 999, p: 1, trade: [] },
  ];
  await withHistory(() => ({ orders: { order: rows } }), async () => {
    const orders = await freedom24Adapter.fetchOrderHistory(db, integration);
    deepStrictEqual(
      orders.map((o) => [o.quantity, o.price, o.date.toISOString()]),
      [
        [1, 10, "2024-02-08T10:00:00.000Z"],
        [-1, 15, "2024-02-08T11:00:00.000Z"],
        [1, 20, "2024-02-09T12:00:00.000Z"],
        [-1, 25, "2024-02-09T13:00:00.000Z"],
      ],
    );
    const { buildAllTimeSeries, instrumentKey } = await import(
      "../../tickers/alltime_chart.ts"
    );
    const points = buildAllTimeSeries(
      {
        orders,
        positions: [],
        transactionBuckets: new Map(),
        bucketName: null,
        now: new Date("2024-02-10"),
      },
      new Map([[instrumentKey(orders[0]), {
        symbol: "BOTZ240315C00033000",
        currency: "USD",
        instrumentType: "OPTION",
        splits: [],
        bars: [
          { date: "2024-02-08", close: .1 },
          { date: "2024-02-09", close: .2 },
        ],
      }]]),
      new Map([["USD", 1]]),
    );
    equal(points.at(-1)!.gain, 10);
    ok(Math.abs(points.at(-1)!.percentage - 100 / 3) < 1e-9);
  });
});

Deno.test("Freedom24 fetches every page and deduplicates overlapping orders and executions", async () => {
  const calls: number[] = [];
  const buy = {
    id: "purchase",
    instr: "+BOTZ.15MAR2024.C33",
    stat: 31,
    oper: 1,
    trade: [
      { id: "buy", date: "2024-02-08T10:00:00Z", q: 1, v: 10 },
    ],
  };
  const first: Freedom24Order[] = Array.from(
    { length: 999 },
    (_, id) => ({ id, stat: 31, oper: 1, trade: [] }),
  );
  first.push(buy);
  await withHistory((body) => {
    equal(body.get("params[order]"), null);
    equal(body.get("params[page][take]"), "1000");
    ok(body.get("params[till]"));
    equal(body.get("params[to]"), null);
    const skip = Number(body.get("params[page][skip]"));
    calls.push(skip);
    return {
      orders: {
        order: skip === 0 ? first : [buy, {
          ...buy,
          id: "same-execution-other-order",
        }, {
          id: "sale",
          instr: buy.instr,
          stat: 21,
          oper: 3,
          trade: [
            { id: "sell", date: "2024-02-09T10:00:00Z", q: 1, v: 15 },
          ],
        }],
      },
    };
  }, async () => {
    const orders = await freedom24Adapter.fetchOrderHistory(db, integration);
    deepStrictEqual(calls, [0, 1000]);
    deepStrictEqual(orders.map((o) => [o.quantity, o.price]), [[1, 10], [
      -1,
      15,
    ]]);
  });
});

Deno.test("Freedom24 retains existing bucket identity when an order fills on multiple days", async () => {
  await withHistory(
    () => ({
      orders: {
        order: [{
          id: 1,
          instr: "ABC.US",
          cur: "EUR",
          oper: 1,
          stat: 21,
          trade: [
            { date: "2024-02-08T10:00:00Z", q: 1, v: 10 },
            { date: "2024-02-09T12:00:00Z", q: 1, v: 20 },
          ],
        }],
      },
    }),
    async () => {
      const orders = await freedom24Adapter.fetchOrderHistory(db, integration);
      deepStrictEqual(orders.map(getOrderTransactionKey), [
        '["2024-02-08","ABC.US","EUR"]',
        '["2024-02-08","ABC.US","EUR"]',
      ]);
      deepStrictEqual(orders.map((o) => o.date.toISOString().slice(0, 10)), [
        "2024-02-08",
        "2024-02-09",
      ]);
      equal(orders[0].currency, "EUR");
    },
  );
});

Deno.test("Freedom24 missing execution amounts use premium units and contract multipliers", async () => {
  await withHistory(() => ({
    orders: {
      order: [
        {
          id: 1,
          instr: "+BOTZ.15MAR2024.C33",
          oper: 1,
          stat: 20,
          trade: [{ q: 1, p: ".1", date: "2024-02-08" }],
        },
        {
          id: 2,
          instr: "+BOTZ.15MAR2024.C33",
          oper: 1,
          stat: 20,
          trade: [{ q: 1, p: ".2", fv: "5000", date: "2024-02-09" }],
        },
        {
          id: 3,
          instr: "+NANOS.29SEP2025.C666",
          oper: 1,
          stat: 31,
          trade: [{ q: 1, p: "2", date: "2024-02-10" }],
        },
      ],
    },
  }), async () => {
    const orders = await freedom24Adapter.fetchOrderHistory(db, integration);
    deepStrictEqual(orders.map((o) => o.price), [10, 10, 2]);
  });
});

Deno.test("Freedom24 refuses broken executions or non-advancing pages instead of returning partial history", async () => {
  for (
    const response of [
      {},
      {
        orders: {
          order: [{
            instr: "ABC.US",
            stat: 31,
            oper: 1,
            trade: [{ date: "2024-02-08", q: "bad", v: "1" }],
          }],
        },
      },
      {
        orders: {
          order: [{
            instr: "ABC.US",
            stat: 21,
            oper: 1,
            q: 1,
            date: "2024-02-08",
          }],
        },
      },
    ]
  ) {
    await withHistory(() => response, async () => {
      await rejects(freedom24Adapter.fetchOrderHistory(db, integration));
    });
  }
  const page = Array.from(
    { length: 1000 },
    (_, id) => ({ id, oper: 1, stat: 31, trade: [] }),
  );
  await withHistory(() => ({ orders: { order: page } }), async () => {
    await rejects(
      freedom24Adapter.fetchOrderHistory(db, integration),
      /pagination did not advance/,
    );
  });
  const fill = { id: "same", q: 1, v: 10, date: "2024-02-08" };
  await withHistory(() => ({
    orders: {
      order: [
        { id: 1, instr: "ABC.US", oper: 1, trade: [fill] },
        { id: 2, instr: "ABC.US", oper: 1, trade: [{ ...fill, v: 20 }] },
      ],
    },
  }), async () => {
    await rejects(
      freedom24Adapter.fetchOrderHistory(db, integration),
      /Conflicting/,
    );
  });
});
