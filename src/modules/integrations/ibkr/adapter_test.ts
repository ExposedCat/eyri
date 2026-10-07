import { deepStrictEqual, equal, throws } from "node:assert/strict";
import { Database } from "@db/sqlite";
import type { Integration } from "../../database/integration.ts";
import { ibkrAdapter } from "./adapter.ts";
import {
  buildAllTimeSeries,
  instrumentKey,
} from "../../tickers/alltime_chart.ts";

const integration: Integration = {
  id: 1,
  userId: 1,
  kind: "ibkr",
  credentials: { instanceUrl: "tcp://localhost:4001", flexQueryId: "test" },
  createdAt: new Date("2026-10-01"),
  updatedAt: new Date("2026-10-01"),
};

async function setup() {
  const db = new Database(":memory:");
  await ibkrAdapter.fetchOrderHistory(db, integration);
  return db;
}

function flex(db: Database, id: string, date: string, quantity: number) {
  db.prepare(`INSERT INTO ibkr_flex_trades
    (integration_id,query_id,trade_key,ticker,date,quantity,price,currency,asset_category,synced_at)
    VALUES (1,'test',?,'VY8GTE',?,?,0.5,'EUR','WAR','2026-10-07')`).run(
    id,
    date,
    quantity,
  );
}
function execution(db: Database, id: string, date: string, quantity: number) {
  db.prepare(`INSERT INTO ibkr_executions
    (integration_id,exec_id,account,ticker,date,quantity,price,currency,asset_category,synced_at)
    VALUES (1,?,'account','VY8GTE',?,?,0.5,'EUR','WAR','2026-10-07')`).run(
    id,
    date,
    quantity,
  );
}

Deno.test("IBKR preserves separate identical Flex warrant purchases and the chart matches the full holding", async () => {
  const db = await setup();
  try {
    flex(db, "fill-1", "2026-10-01", 100);
    flex(db, "fill-2", "2026-10-01", 100);
    const orders = await ibkrAdapter.fetchOrderHistory(db, integration);
    equal(orders.length, 2);
    equal(orders.reduce((sum, order) => sum + order.quantity, 0), 200);
    const series = buildAllTimeSeries(
      {
        orders,
        positions: [{
          integrationId: 1,
          integrationKind: "ibkr",
          account: "account",
          ticker: "VY8GTE",
          currency: "EUR",
          assetCategory: "WAR",
          amount: 200,
          currentPrice: 0.6,
          averageUnitPrice: 0.5,
          totalInput: 100,
          totalNow: 120,
          unrealizedPnl: 20,
          realizedPnl: null,
          dailyPnl: null,
          dailyPnlPercentage: null,
          dailyPnlBaseline: null,
          openedAt: new Date("2026-10-01"),
        }],
        transactionBuckets: new Map(),
        bucketName: null,
        now: new Date("2026-10-07"),
      },
      new Map([[instrumentKey(orders[0]), {
        symbol: "VONTOBEL:DE000VY8GTE6",
        currency: "EUR",
        splits: [],
        bars: [{ date: "2026-10-01", close: 0.5 }, {
          date: "2026-10-06",
          close: 0.6,
        }],
      }]]),
      new Map([["EUR", 1]]),
    );
    equal(series.at(-1)!.percentage, 20);
    equal(series.at(-1)!.gain, 20);
  } finally {
    db.close();
  }
});

Deno.test("IBKR preserves identical recent executions while excluding execution rows covered by Flex", async () => {
  const db = await setup();
  try {
    flex(db, "old-1", "2026-10-01", 100);
    flex(db, "old-2", "2026-10-01", 100);
    execution(db, "already-in-flex-1", "2026-10-01", 100);
    execution(db, "already-in-flex-2", "2026-10-01", 100);
    execution(db, "new-1", "2026-10-07", 100);
    execution(db, "new-2", "2026-10-07", 100);
    const orders = await ibkrAdapter.fetchOrderHistory(db, integration);
    equal(orders.length, 4);
    equal(orders.reduce((sum, order) => sum + order.quantity, 0), 400);
    deepStrictEqual(
      orders.map((order) => order.date.toISOString().slice(0, 10)),
      ["2026-10-01", "2026-10-01", "2026-10-07", "2026-10-07"],
    );
  } finally {
    db.close();
  }
});

Deno.test("IBKR preserves identical buys and sells when only execution history is available", async () => {
  const db = await setup();
  try {
    execution(db, "buy-1", "2026-10-06", 100);
    execution(db, "buy-2", "2026-10-06", 100);
    execution(db, "sell-1", "2026-10-07", -100);
    execution(db, "sell-2", "2026-10-07", -100);
    const orders = await ibkrAdapter.fetchOrderHistory(db, integration);
    deepStrictEqual(orders.map((order) => order.quantity), [
      100,
      100,
      -100,
      -100,
    ]);
  } finally {
    db.close();
  }
});

Deno.test("incomplete VY8GTE history reports the actual recorded and live quantities", async () => {
  const db = await setup();
  try {
    execution(db, "first", "2026-10-07", 230);
    execution(db, "second", "2026-10-07", 2300);
    execution(db, "third", "2026-10-07", 720);
    const orders = await ibkrAdapter.fetchOrderHistory(db, integration);
    equal(orders.reduce((sum, order) => sum + order.quantity, 0), 3250);
    throws(() =>
      buildAllTimeSeries(
        {
          orders,
          positions: [{
            integrationId: 1,
            integrationKind: "ibkr",
            account: "account",
            ticker: "VY8GTE",
            currency: "EUR",
            assetCategory: "WAR",
            amount: 3299,
            currentPrice: 0.2828,
            averageUnitPrice: 904.6900484 / 3299,
            totalInput: 904.6900484,
            totalNow: 3299 * 0.2828,
            unrealizedPnl: null,
            realizedPnl: null,
            dailyPnl: null,
            dailyPnlPercentage: null,
            dailyPnlBaseline: null,
            openedAt: null,
          }],
          transactionBuckets: new Map(),
          bucketName: null,
          now: new Date("2026-10-07"),
        },
        new Map([[instrumentKey(orders[0]), {
          symbol: "VONTOBEL:DE000VY8GTE6",
          currency: "EUR",
          splits: [],
          bars: [{ date: "2026-10-06", close: 0.27 }],
        }]]),
        new Map([["EUR", 1]]),
      ), {
      message:
        "Cannot build VY8GTE chart: trade history shows 3250 held, but the broker reports 3299.",
    });
  } finally {
    db.close();
  }
});
