import { deepStrictEqual, equal, match, ok } from "node:assert/strict";
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
import type { Freedom24PortfolioPosition, Freedom24Quote } from "./api.ts";

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
  globalThis.fetch = async (input, init) => {
    const command = String(input).split("/").at(-1);
    equal(new URLSearchParams(String(init?.body)).get("apiKey"), "test");
    const body =
      command === "getPositionJson"
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
    return new Response(JSON.stringify(body));
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
      for (const render of [
        buildIntegratedDailyPerformanceList,
        buildIntegratedPerformanceList,
      ]) {
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
