import { equal, match, ok, rejects, throws } from "node:assert/strict";
import { Database } from "@db/sqlite";
import type { IntegrationAccountPerformance, IntegrationOrder, IntegrationPortfolioPosition } from "../integrations/types.ts";
import type { PriceHistory } from "../market_data/history.ts";
import { accountReturn } from "./account_return.ts";
import { buildIntegratedAllTimePerformanceList, buildIntegratedAllTimeReport } from "./portfolio.ts";
import { buildAllTimeSeries, instrumentKey, loadAllTimeDataset } from "./alltime_chart.ts";
import { buildChartBenchmark } from "./chart_benchmark.ts";
import { buildBucketCashAccounts, excludeBucketCapital } from "./bucket_funding.ts";

const rates = new Map([["USD", 1]]);
const orders: IntegrationOrder[] = [
  { ticker: "FIRST", quantity: 1, price: 100, date: new Date("2025-01-01") },
  { ticker: "FIRST", quantity: -1, price: 500, date: new Date("2025-01-02") },
  { ticker: "SECOND", quantity: 1, price: 500, date: new Date("2025-01-02") },
].map(order => ({ integrationId: 1, integrationKind: "ibkr", account: "test", currency: "USD", assetCategory: "STK", ...order }));
const position: IntegrationPortfolioPosition = {
  integrationId: 1, integrationKind: "ibkr", account: "test", currency: "USD",
  ticker: "SECOND", assetCategory: "STK", amount: 1,
  averageUnitPrice: 500, currentPrice: 525, totalInput: 500, totalNow: 525,
  unrealizedPnl: 25, realizedPnl: null,
  dailyPnl: null, dailyPnlPercentage: null, dailyPnlBaseline: null,
  openedAt: new Date("2025-01-02"),
};
const account: IntegrationAccountPerformance = {
  integrationId: 1, currency: "USD", totalValue: 525, netContributions: 100,
  pnl: 425, deposits: 100, withdrawals: 0, cash: 0, ledgerCash: { USD: 0 },
  openedAt: new Date("2025-01-01"), historyThrough: new Date("2025-01-04"),
  positionValue: 525, investmentValue: 525,
  fundingHistory: [{ date: "2025-01-01", amount: 100 }],
  reportedComponents: [{ currency: "USD", cost: 100, pnl: 400 }, { currency: "USD", cost: 500, pnl: 25 }],
};
const histories = new Map<string, PriceHistory>([
  [instrumentKey(orders[0]), { symbol: "FIRST", currency: "USD", instrumentType: "EQUITY", splits: [], bars: [{ date: "2025-01-01", close: 100 }, { date: "2025-01-02", close: 500 }] }],
  [instrumentKey(orders[2]), { symbol: "SECOND", currency: "USD", instrumentType: "EQUITY", splits: [], bars: [{ date: "2025-01-02", close: 500 }, { date: "2025-01-03", close: 525 }] }],
]);
const near = (actual: number, expected: number) => ok(Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`);

Deno.test("excluded bucket capital reduces real deposits without counting the remaining account's reinvestment", async () => {
  for (const sold of [false, true]) {
    const bucketOrders = [{ ...orders[0], ticker: "BUCKET" }, ...(sold ? [{ ...orders[0], ticker: "BUCKET", quantity: -1, price: 120, date: new Date("2025-01-03") }] : [])];
    const bucket = await buildBucketCashAccounts({
      orders: bucketOrders,
      positions: sold ? [] : [{ ...position, ticker: "BUCKET", totalInput: 100, currentPrice: 120, totalNow: 120, unrealizedPnl: 20 }],
      transactionBuckets: new Map(), bucketName: null,
    });
    const broker = { ...account, deposits: 200, netContributions: 200, totalValue: 645, pnl: 445, cash: sold ? 120 : 0, positionValue: sold ? 525 : 645, investmentValue: sold ? 525 : 645, fundingHistory: [{ date: "2025-01-01", amount: 200 }] };
    const [remaining] = await excludeBucketCapital([broker], bucket);
    equal(remaining.deposits, 100);
    equal(remaining.totalValue, 525);
    equal(remaining.cash, 0);
    equal(remaining.pnl, 425);
    equal(accountReturn([remaining], new Set([1]), rates).percentage, 425);
    const report = await buildIntegratedAllTimeReport({ positions: [position], orders, accountPerformances: [remaining] });
    equal(report?.totalReturnPercentage, 425);
    await rejects(excludeBucketCapital([{ ...broker, deposits: 50 }], bucket), /exceeds account deposits/);
  }
});

Deno.test("benchmark bucket allocations reduce contribution capital rather than counting as external withdrawals", () => {
  const history: PriceHistory = { symbol: "CSPX.L", currency: "USD", instrumentType: "ETF", splits: [], bars: [{ date: "2025-01-01", close: 100 }, { date: "2025-01-02", close: 100 }, { date: "2025-01-03", close: 110 }] };
  const benchmark = buildChartBenchmark(history, [{ date: "2025-01-01", amountUsd: 1000 }, { date: "2025-01-02", amountUsd: -300, allocation: true }], "2025-01-01", "2025-01-03");
  near(benchmark.points.at(-1)!.gain, 70);
  near(benchmark.points.at(-1)!.percentage, 10);
  const withdrawal = buildChartBenchmark(history, [{ date: "2025-01-01", amountUsd: 1000 }, { date: "2025-01-02", amountUsd: -300 }], "2025-01-01", "2025-01-03");
  near(withdrawal.points.at(-1)!.percentage, 7);
});

Deno.test("cash-funded buckets treat each purchase as fresh capital while broker accounts retain the reinvestment fix", async () => {
  for (const share of [1, .5823]) {
    const selectedOrders = orders.map(order => ({ ...order, quantity: order.quantity * share }));
    const selectedPosition = { ...position, amount: share, totalInput: 500 * share, totalNow: 525 * share, unrealizedPnl: 25 * share };
    const args = { positions: [selectedPosition], orders: selectedOrders, transactionBuckets: new Map<string, string>(), bucketName: null, now: new Date("2025-01-04") };
    const accounts = await buildBucketCashAccounts(args);
    equal(accounts[0].fundingSource, "bucket_cash");
    near(accounts[0].deposits, 600 * share);
    near(accounts[0].cash, 500 * share);
    near(accounts[0].pnl, 425 * share);
    const report = await buildIntegratedAllTimeReport({ ...args, accountPerformances: accounts });
    near(report!.totalReturnPercentage!, 425 / 600 * 100);
    equal(report!.performances.some(performance => performance.accountAdjustment), false);
    const series = buildAllTimeSeries({ ...args, accountPerformances: accounts }, histories, rates);
    near(series.at(-2)!.percentage!, 425 / 600 * 100);
    near(series.at(-1)!.percentage!, report!.totalReturnPercentage!);
    equal(accountReturn([account], new Set([1]), rates).percentage, 425);
    const mixed = accountReturn([{ ...account, totalValue: 425, withdrawals: 100 }, { ...accounts[0], integrationId: 2 }], new Set([1, 2]), rates);
    near(mixed.percentage!, (425 + 425 * share) / (100 + 600 * share) * 100);
  }
});

Deno.test("lifetime return keeps the original deposit after reinvesting gains and after liquidation", async () => {
  for (const liquidated of [false, true]) {
    const snapshot = liquidated ? { ...account, cash: 525, positionValue: 0, investmentValue: 0 } : account;
    const args = {
      positions: liquidated ? [] : [position],
      orders: liquidated ? [...orders, { ...orders[2], quantity: -1, price: 525, date: new Date("2025-01-03") }] : orders,
      accountPerformances: [snapshot],
    };
    const report = await buildIntegratedAllTimeReport(args);
    equal(report?.total.change, 425);
    equal(report?.totalReturnPercentage, 425);
    const text = await buildIntegratedAllTimePerformanceList({ ...args, formatTicker: ticker => ticker });
    match(text, /Total: \+425\.00% \+\$425\.00/);
    equal(text.includes("70.83%"), false);
    equal(text.includes("SECOND +5.00%"), false);
  }
});

Deno.test("gross-deposit return handles withdrawals, redeposits, zero deposits, incomplete accounts and ambiguous transfers", () => {
  equal(accountReturn([{ ...account, totalValue: 125, withdrawals: 400 }], new Set([1]), rates).percentage, 425);
  equal(accountReturn([{ ...account, deposits: 200, withdrawals: 100 }], new Set([1]), rates).percentage, 212.5);
  equal(accountReturn([{ ...account, deposits: 0 }], new Set([1]), rates).percentage, null);
  equal(accountReturn([account], new Set([1, 2]), rates).percentage, null);
  equal(accountReturn([account, { ...account, integrationId: 2 }], new Set([1, 2]), rates).percentage, 425);
  equal(accountReturn([account, { ...account, integrationId: 2, withdrawals: 50 }], new Set([1, 2]), rates).percentage, null);
  equal(accountReturn([account, { ...account, integrationId: 2, fundingIncludesTransfers: true }], new Set([1, 2]), rates).percentage, null);
  throws(() => accountReturn([account, account], new Set([1]), rates), /Duplicate/);
});

Deno.test("historical chart never mixes trade-cost percentages with the deposit-based live return", () => {
  const args = { positions: [position], orders, transactionBuckets: new Map<string, string>(), bucketName: null, now: new Date("2025-01-04"), accountPerformances: [account] };
  const series = buildAllTimeSeries(args, histories, rates);
  equal(series.at(-2)?.gain, 425);
  equal(series.at(-2)?.percentage, null);
  equal(series.at(-1)?.percentage, 425);
  const incomplete = buildAllTimeSeries({ ...args, accountPerformances: [] }, histories, rates);
  equal(incomplete.at(-1)?.percentage, null);
  equal(incomplete.at(-1)?.gain, 425);
});

Deno.test("benchmark invests the deposited 100 once, despite 600 of purchase turnover", async () => {
  const db = new Database(":memory:");
  const benchmarkHistory: PriceHistory = { symbol: "CSPX.L", currency: "USD", instrumentType: "ETF", splits: [], bars: [{ date: "2025-01-01", close: 100 }, { date: "2025-01-04", close: 110 }] };
  const cache = {
    resolve: (source: { ticker: string }) => Promise.resolve(source.ticker),
    get: (symbol: string) => Promise.resolve(symbol === "CSPX.L" ? benchmarkHistory : [...histories.values()].find(history => history.symbol === symbol)!),
  };
  try {
    const dataset = await loadAllTimeDataset(db, { positions: [position], orders, transactionBuckets: new Map(), bucketName: null, now: new Date("2025-01-04"), accountPerformances: [account] }, 1, "Test", cache as never);
    equal(dataset.benchmarkPurchases?.length, 1);
    equal(dataset.benchmarkPurchases?.[0].amountUsd, 100);
    near(dataset.benchmark!.points.at(-1)!.gain, 10);
    near(dataset.benchmark!.points.at(-1)!.percentage, 10);
    const incomplete = await loadAllTimeDataset(db, { positions: [position], orders, transactionBuckets: new Map(), bucketName: null, now: new Date("2025-01-04"), accountPerformances: [{ ...account, fundingHistory: undefined }] }, 1, "Test", cache as never);
    equal(incomplete.benchmark, undefined);
    match(incomplete.notes!.join(" "), /dated external funding/);
  } finally { db.close(); }
});

Deno.test("benchmark withdrawals sell units without reducing gross deposits or losing withdrawn value", () => {
  const history: PriceHistory = { symbol: "CSPX.L", currency: "USD", instrumentType: "ETF", splits: [], bars: [{ date: "2025-01-01", close: 100 }, { date: "2025-01-02", close: 100 }, { date: "2025-01-03", close: 110 }] };
  const benchmark = buildChartBenchmark(history, [{ date: "2025-01-01", amountUsd: 100 }, { date: "2025-01-02", amountUsd: -50 }], "2025-01-01", "2025-01-03");
  near(benchmark.points.at(-1)!.gain, 5);
  near(benchmark.points.at(-1)!.percentage, 5);
  throws(() => buildChartBenchmark(history, [{ date: "2025-01-01", amountUsd: -50 }], "2025-01-01", "2025-01-03"), /cannot fund/);
});
