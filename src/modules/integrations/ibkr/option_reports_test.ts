import { equal, ok } from "node:assert/strict";
import { Database } from "@db/sqlite";
import type { Integration } from "../../database/integration.ts";
import type { IntegrationAccountPerformance } from "../types.ts";
import type { PriceHistory } from "../../market_data/history.ts";
import { ibkrAdapter } from "./adapter.ts";
import { parseTrades, writeBatchTrades } from "./flex.ts";
import { buildIntegratedAllTimeReport, buildIntegratedSoldPerformances, getOrderTransactionKey } from "../../tickers/portfolio.ts";
import { buildAllTimeSeries, instrumentKey, loadAllTimeDataset } from "../../tickers/alltime_chart.ts";
import { buildHistoricalReportSeries, executionCash } from "../../tickers/historical_report.ts";

const ticker = "NVS   271217C00230000";
const integration: Integration = { id: 7, userId: 1, kind: "ibkr", credentials: {
  instanceUrl: "tcp://localhost:4001", flexQueryId: "trades",
}, createdAt: new Date(), updatedAt: new Date() };
const now = new Date("2026-11-12T12:00:00Z");
const range = { from: new Date("2026-11-01"), to: new Date("2026-11-12") };
const xml = (sale = false, multiplier = 100) => `<FlexQueryResponse><Trades>
  <Trade symbol="${ticker}" tradeDate="20261110" quantity="1" tradePrice="1.01" currency="USD" assetCategory="OPT" multiplier="${multiplier}" ibCommission="-1" ibCommissionCurrency="USD" />
  ${sale ? `<Trade symbol="${ticker}" tradeDate="20261112" quantity="-1" tradePrice="2.17" currency="USD" assetCategory="OPT" multiplier="${multiplier}" ibCommission="-2" ibCommissionCurrency="USD" />` : ""}
  </Trades></FlexQueryResponse>`;
const near = (actual: number, expected: number) => ok(Math.abs(actual - expected) < 1e-8, `${actual} != ${expected}`);

Deno.test("NVS Flex purchases and Gateway sales share FIFO history across reports, charts and a Flex refresh", async () => {
  const db = new Database(":memory:");
  try {
    writeBatchTrades(db, integration, "trades", 0, range, parseTrades(xml()));
    await ibkrAdapter.fetchOrderHistory(db, integration);
    db.prepare(`INSERT INTO ibkr_executions
      (integration_id,exec_id,account,ticker,date,quantity,price,currency,asset_category,synced_at)
      VALUES (7,'sale','U7',?,'2026-11-12',-1,2.17,'USD','OPT','2026-11-12')`).run(ticker);
    const orders = await ibkrAdapter.fetchOrderHistory(db, integration);
    equal(orders[0].account, "");
    equal(orders[1].account, "U7");
    equal(orders[0].price, 101);
    equal(orders[1].price, 217);
    equal(orders[0].commission?.amount, -1);
    equal(executionCash(orders[0]).reduce((sum, event) => sum + event.amount, 0), -102);
    equal(executionCash(orders[1])[0].amount, 217);
    // Bucket identity still uses the original date, symbol and currency.
    equal(getOrderTransactionKey(orders[0]), JSON.stringify(["2026-11-10", ticker, "USD"]));
    near(buildIntegratedSoldPerformances(orders)[0].realizedPnl, 115);
    near((await buildIntegratedAllTimeReport({ positions: [], orders }))!.total.change!, 115);
    const history: PriceHistory = { symbol: ticker, currency: "USD", splits: [], bars: [
      { date: "2026-11-10", close: 1.01 }, { date: "2026-11-11", close: 1.5 }, { date: "2026-11-12", close: 2.17 },
    ] };
    const histories = new Map([[instrumentKey(orders[0]), history]]);
    const rates = new Map([["USD", 1]]);
    const account: IntegrationAccountPerformance = { integrationId: 7, currency: "USD", totalValue: 1115,
      deposits: 1000, withdrawals: 0, netContributions: 1000, pnl: 115, cash: 1115, ledgerCash: { USD: 1115 },
      statementCash: { USD: 898 }, historyThrough: new Date("2026-11-11"), openedAt: new Date("2026-11-10"),
      positionValue: 0, investmentValue: 0, fundingProvisional: true,
      fundingHistory: [{ date: "2026-11-10", amount: 1000 }],
      cashHistory: [{ date: "2026-11-10", currency: "USD", amount: 1000, type: "Deposit" }] };
    const args = { positions: [], orders, transactionBuckets: new Map<string, string>(), bucketName: null, now, accountPerformances: [account] };
    const legacy = buildAllTimeSeries(args, histories, rates);
    near(legacy.find(point => point.date === "2026-11-11")!.gain, 48);
    near(legacy.at(-1)!.gain, 115);
    const cache = {
      resolve: (source: { ticker: string }) => Promise.resolve(source.ticker),
      get: (symbol: string) => Promise.resolve(symbol === ticker ? history : {
        symbol, currency: "USD", splits: [], bars: history.bars.map(bar => ({ ...bar, close: 100 })),
      }),
    };
    for (const kind of ["perf", "alltime", "worth"] as const) {
      const points = buildHistoricalReportSeries(args, histories, rates, new Map(), kind);
      near(points.find(point => point.date === "2026-11-11")!.gain, kind === "worth" ? 1048 : 48);
      near(points.at(-1)!.gain, kind === "worth" ? 1115 : kind === "alltime" ? 115 : 0);
      const dataset = await loadAllTimeDataset(db, { ...args, kind }, 1, "Test", cache as never);
      near(dataset.points.at(-1)!.gain, kind === "worth" ? 1115 : kind === "alltime" ? 115 : 0);
    }
    // Other integrations retain their own lots even with identical symbols.
    equal(buildIntegratedSoldPerformances([orders[0], { ...orders[1], integrationId: 8 }]).length, 0);
    // Once Flex supplies the sale fee, replace the Gateway fill without
    // multiplying normalized prices twice or counting the sale twice.
    writeBatchTrades(db, integration, "trades", 0, range, parseTrades(xml(true)));
    const refreshed = await ibkrAdapter.fetchOrderHistory(db, integration);
    equal(refreshed.length, 2);
    near(buildIntegratedSoldPerformances(refreshed)[0].realizedPnl, 113);
    near((await buildIntegratedAllTimeReport({ positions: [], orders: refreshed }))!.total.change!, 113);
  } finally { db.close(); }
});

Deno.test("Flex option multiplier metadata survives storage and repeated reads", async () => {
  const db = new Database(":memory:");
  try {
    writeBatchTrades(db, integration, "trades", 0, range, parseTrades(xml(true, 10)));
    for (let index = 0; index < 2; index++) {
      const orders = await ibkrAdapter.fetchOrderHistory(db, integration);
      near(orders[0].price!, 10.1);
      near(orders[1].price!, 21.7);
      equal(orders[0].historicalPriceMultiplier, 10);
      near(buildIntegratedSoldPerformances(orders)[0].realizedPnl, 8.6);
    }
    equal(db.prepare("SELECT price FROM ibkr_flex_trades ORDER BY date LIMIT 1").get()!.price, 1.01);
  } finally { db.close(); }
});
