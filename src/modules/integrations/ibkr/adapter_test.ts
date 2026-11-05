import { deepStrictEqual, equal, throws } from "node:assert/strict";
import { Database } from "@db/sqlite";
import type { Integration } from "../../database/integration.ts";
import type { IntegrationPortfolioPosition } from "../types.ts";
import { enrichContractIdentity, ibkrAdapter, readDailyPnl } from "./adapter.ts";
import { EventEmitter } from "node:events";
import { EventName, type IBApi } from "@stoqey/ib";
import { ibkrSessions } from "./session.ts";
import { cacheIbkrStockGrants } from "./grants.ts";
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

Deno.test("IBKR portfolio keeps contract identity during parallel enrichment and ignores other account events", async () => {
  const db = new Database(":memory:");
  const original = ibkrSessions.run;
  class Api extends EventEmitter {
    reqManagedAccts() {
      this.emit(EventName.error, new Error("farm ready"), 2104, -1);
      this.emit(EventName.managedAccounts, "U1");
    }
    reqAccountUpdates(subscribe: boolean) {
      if (!subscribe) return;
      this.emit(EventName.updatePortfolio, { conId: 123, symbol: "AAPL", secType: "STK", currency: "USD" }, 999, 120, 119880, 100, 19980, 0, "OTHER");
      this.emit(EventName.accountDownloadEnd, "OTHER");
      this.emit(EventName.updatePortfolio, { conId: 123, symbol: "AAPL", secType: "STK", currency: "USD" }, 2, 120, 240, 100, 40, 0, "U1");
      this.emit(EventName.accountDownloadEnd, "U1");
    }
    reqContractDetails(id: number) {
      setTimeout(() => {
        this.emit(EventName.contractDetails, id, { contract: { primaryExch: "NASDAQ" }, secIdList: [{ tag: "ISIN", value: "US0378331005" }] });
        this.emit(EventName.contractDetailsEnd, id);
      }, 0);
    }
    reqPnLSingle(id: number) { this.emit(EventName.pnlSingle, id, 2, 10, 40, 0, 240); }
    cancelPnLSingle() {}
  }
  const api = new Api();
  ibkrSessions.run = async (_config, action) => await action(api as unknown as IBApi);
  try {
    const [position] = await ibkrAdapter.fetchPortfolio(db, integration);
    equal(position.account, "U1");
    equal(position.amount, 2);
    equal(position.exchange, "NASDAQ");
    equal(position.isin, "US0378331005");
    equal(position.dailyPnl, 10);
    equal(position.dailyPnlBaseline, 230);
    deepStrictEqual(api.eventNames(), []);
  } finally { ibkrSessions.run = original; db.close(); }
});

Deno.test("IBKR P/L completes on data or a terminal request error without waiting for the timeout", async () => {
  class Api extends EventEmitter {
    cancelled: number[] = [];
    reqPnLSingle(id: number) {
      this.emit(EventName.error, new Error("farm connected"), 2104, -1);
      if (id === 50_000) this.emit(EventName.pnlSingle, id, 1, 5, 1, 0, 105);
      else this.emit(EventName.error, new Error("unsupported P/L"), 200, id);
    }
    cancelPnLSingle(id: number) { this.cancelled.push(id); }
  }
  const api = new Api();
  const positions = [1, 2].map(conId => ({ conId }) as IntegrationPortfolioPosition & { conId: number });
  const result = await readDailyPnl(api as unknown as IBApi, positions, "U1", 60_000);
  equal(result.get(1)?.dailyPnl, 5);
  equal(result.has(2), false);
  deepStrictEqual(api.cancelled, [50_000, 50_001]);
  deepStrictEqual(api.eventNames(), []);
});

Deno.test("IBKR P/L waits for usable data after unset updates and preserves partial values", async () => {
  class Api extends EventEmitter {
    cancelled: number[] = [];
    reqPnLSingle(id: number) {
      this.emit(EventName.pnlSingle, id, 1, Number.MAX_VALUE, 0, 0, Number.MAX_VALUE);
      queueMicrotask(() => {
        this.emit(EventName.pnlSingle, id, 1, 5, 0, 0, Number.MAX_VALUE);
        this.emit(EventName.pnlSingle, id, 1, Number.MAX_VALUE, 0, 0, 105);
      });
    }
    cancelPnLSingle(id: number) { this.cancelled.push(id); }
  }
  const api = new Api();
  const result = await readDailyPnl(api as unknown as IBApi, [{ conId: 1 } as IntegrationPortfolioPosition & { conId: number }], "U1", 1000);
  deepStrictEqual(result.get(1), { dailyPnl: 5, marketValue: 105 });
  deepStrictEqual(api.cancelled, [50_000]);
  deepStrictEqual(api.eventNames(), []);
});

Deno.test("IBKR P/L accepts a first response arriving after two seconds", async () => {
  class Api extends EventEmitter {
    timer: ReturnType<typeof setTimeout> | undefined;
    reqPnLSingle(id: number) {
      this.timer = setTimeout(() => this.emit(EventName.pnlSingle, id, 1, 5, 0, 0, 105), 2100);
    }
    cancelPnLSingle() { clearTimeout(this.timer); }
  }
  const api = new Api();
  const result = await readDailyPnl(api as unknown as IBApi, [{ conId: 1 } as IntegrationPortfolioPosition & { conId: number }], "U1");
  deepStrictEqual(result.get(1), { dailyPnl: 5, marketValue: 105 });
  deepStrictEqual(api.eventNames(), []);
});

Deno.test("received IBKR shares use zero investor cost in the main portfolio instead of their broker grant valuation", async () => {
  const db = new Database(":memory:");
  const original = ibkrSessions.run;
  class Api extends EventEmitter {
    reqManagedAccts() { this.emit(EventName.managedAccounts, "U1"); }
    reqAccountUpdates(subscribe: boolean) {
      if (!subscribe) return;
      this.emit(EventName.updatePortfolio, { conId: 123, symbol: "IBKR", secType: "STK", currency: "USD" }, 2, 120, 240, 100, 40, 0, "U1");
      this.emit(EventName.accountDownloadEnd, "U1");
    }
    reqContractDetails(id: number) {
      this.emit(EventName.contractDetails, id, { contract: { primaryExch: "NASDAQ" }, secIdList: [{ tag: "ISIN", value: "US45841N1072" }] });
      this.emit(EventName.contractDetailsEnd, id);
    }
    reqPnLSingle(id: number) { this.emit(EventName.pnlSingle, id, 2, 10, 40, 0, 240); }
    cancelPnLSingle() {}
  }
  ibkrSessions.run = async (_config, action) => await action(new Api() as unknown as IBApi);
  try {
    cacheIbkrStockGrants(db, integration, "test", { from: new Date("2026-10-01"), to: new Date("2026-10-31") },
      '<FlexQueryResponse><FlexStatement accountId="U1"><StockGrantActivities><StockGrantActivity accountId="U1" symbol="IBKR" currency="USD" reportDate="20261006" quantity="2" /></StockGrantActivities></FlexStatement></FlexQueryResponse>');
    const [position] = await ibkrAdapter.fetchPortfolio(db, integration);
    equal(position.totalInput, 0);
    equal(position.averageUnitPrice, 0);
    equal(position.totalNow, 240);
    equal(position.unrealizedPnl, 240);
    equal(position.openedAt?.toISOString().slice(0, 10), "2026-10-06");
  } finally { ibkrSessions.run = original; db.close(); }
});

Deno.test("IBKR missing P/L remains unavailable and cleans up on deadline or disconnect", async () => {
  class Api extends EventEmitter {
    cancelled = false;
    reqPnLSingle() {}
    cancelPnLSingle() { this.cancelled = true; }
  }
  for (const disconnect of [false, true]) {
    const api = new Api();
    const request = readDailyPnl(api as unknown as IBApi, [{ conId: 1 } as IntegrationPortfolioPosition & { conId: number }], "U1", disconnect ? 60_000 : 1);
    if (disconnect) api.emit(EventName.disconnected);
    equal((await request).size, 0);
    equal(api.cancelled, true);
    deepStrictEqual(api.eventNames(), []);
  }
});

Deno.test("IBKR preserves and caches the actual contract exchange and ISIN for ambiguous symbols", async () => {
  const db = new Database(":memory:");
  let calls = 0;
  class Api extends EventEmitter {
    reqContractDetails(id: number) {
      calls++;
      this.emit(EventName.contractDetails, id, { contract: { primaryExch: "LSEETF" }, secIdList: [{ tag: "ISIN", value: "IE000B9PQW54" }] });
      this.emit(EventName.contractDetailsEnd, id);
    }
  }
  const api = new Api();
  try {
    const first = { ticker: "CURE", assetCategory: "STK", conId: 583966268 } as IntegrationPortfolioPosition & { conId: number };
    await enrichContractIdentity(db, api as unknown as IBApi, [first], 100);
    equal(first.exchange, "LSEETF");
    equal(first.isin, "IE000B9PQW54");
    const second = { ticker: "CURE", assetCategory: "STK", conId: 583966268 } as IntegrationPortfolioPosition & { conId: number };
    await enrichContractIdentity(db, api as unknown as IBApi, [second], 100);
    equal(second.exchange, "LSEETF");
    equal(calls, 1);
    equal(api.listenerCount(EventName.contractDetails), 0);
  } finally { db.close(); }
});

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
    equal(series.at(-1)!.percentage, null);
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
