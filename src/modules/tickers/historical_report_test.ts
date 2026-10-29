import { deepStrictEqual, equal, ok, throws } from "node:assert/strict";
import type { IntegrationAccountPerformance, IntegrationOrder, IntegrationPortfolioPosition } from "../integrations/types.ts";
import type { PriceHistory } from "../market_data/history.ts";
import { buildHistoricalReportSeries, executionCash } from "./historical_report.ts";
import { buildReportSnapshot } from "./report.ts";

const now = new Date("2025-01-02T12:00:00Z");
const near = (actual: number, expected: number) => ok(Math.abs(actual - expected) < 1e-8, `${actual} != ${expected}`);
const trade = (ticker: string, quantity: number, price: number, date = "2025-01-01", fee = 0): IntegrationOrder => ({
  integrationId: 1, integrationKind: "ibkr", account: "U1", ticker, quantity, price, date: new Date(date), currency: "USD", assetCategory: "STK",
  commission: { amount: -fee, currency: "USD" },
});
const position = (ticker: string, amount: number, cost: number, price: number): IntegrationPortfolioPosition => ({
  integrationId: 1, integrationKind: "ibkr", account: "U1", ticker, amount, averageUnitPrice: cost / amount, totalInput: cost,
  currency: "USD", assetCategory: "STK", currentPrice: price, totalNow: amount * price, unrealizedPnl: amount * price - cost,
  realizedPnl: 0, dailyPnl: 0, dailyPnlPercentage: 0, dailyPnlBaseline: amount * price, openedAt: new Date("2025-01-01"),
});
const account = (extra: Partial<IntegrationAccountPerformance> = {}): IntegrationAccountPerformance => ({
  integrationId: 1, currency: "USD", totalValue: 1100, pnl: 100, deposits: 1000, withdrawals: 0, netContributions: 1000,
  fundingHistory: [{ date: "2025-01-01", amount: 1000 }], cashHistory: [{ date: "2025-01-01", currency: "USD", amount: 1000, type: "Deposit" }],
  cash: 0, ledgerCash: { USD: 0 }, positionValue: 1100, investmentValue: 1100, openedAt: new Date("2025-01-01"), historyThrough: now,
  reportedComponents: [{ currency: "USD", cost: 1000, pnl: 100 }], ...extra,
});
const histories = (ticker = "A", first = 10, last = 11) => new Map<string, PriceHistory>([[JSON.stringify([ticker, "USD"]), {
  symbol: ticker, currency: "USD", splits: [], bars: [{ date: "2025-01-01", close: first }, { date: "2025-01-02", close: last }],
}]]);
const usd = new Map([["USD", 1]]);

Deno.test("ledger reconstruction includes native funding, FX, fees, dividends and withholding on their actual dates", async () => {
  const foreign = account({ currency: "CZK", deposits: 50000, netContributions: 50000, totalValue: 66299, pnl: 16299,
    cash: 299, ledgerCash: { CZK: -1, USD: 5 }, positionValue: 66000, investmentValue: 66000,
    fundingHistory: [{ date: "2025-01-01", amount: 50000 }],
    cashHistory: [{ date: "2025-01-01", currency: "CZK", amount: 50000, type: "Deposit" },
      { date: "2025-01-02", currency: "USD", amount: 10, type: "Dividends" },
      { date: "2025-01-02", currency: "USD", amount: -3, type: "Withholding Tax" }],
    reportedComponents: [{ currency: "USD", cost: 1002, pnl: 98 }],
  });
  const fx = { ...trade("USD.CZK", 1000, 50, "2025-01-01", 0), currency: "CZK", assetCategory: "CASH", commission: { currency: "CZK", amount: -1 } };
  const args = { positions: [position("A", 100, 1002, 11)], orders: [fx, trade("A", 100, 10, "2025-01-01", 2)],
    transactionBuckets: new Map<string, string>(), bucketName: null, accountPerformances: [foreign], now };
  const rates = new Map([["USD", 1], ["CZK", 1 / 60]]);
  const historical = new Map([["CZK", [{ date: "2024-12-31", factor: 1 / 50 }, { date: "2025-01-01", factor: 1 / 50 }, { date: "2025-01-02", factor: 1 / 60 }]]]);
  const request: typeof fetch = async () => Response.json({ base: "USD", quote: "CZK", rate: 60 });
  for (const kind of ["perf", "alltime", "worth"] as const) {
    const points = buildHistoricalReportSeries(args, histories(), rates, historical, kind);
    const report = await buildReportSnapshot({ ...args, request }, kind);
    near(points.at(-1)!.gain, report.value);
    if (kind === "alltime") { near(points[1].gain, -2.02); near(points.at(-1)!.gain, 16299 / 60); }
    if (kind === "perf") near(points.at(-1)!.gain, 98);
    if (kind === "worth") near(points.at(-1)!.gain, 66299 / 60);
  }
});

Deno.test("reinvested sale proceeds remain cash, never a second account deposit", () => {
  const args = { positions: [position("B", 10, 1100, 115.5)],
    orders: [trade("A", 10, 100), trade("A", -10, 110, "2025-01-02"), trade("B", 10, 110, "2025-01-02")],
    transactionBuckets: new Map<string, string>(), bucketName: null, accountPerformances: [account({ totalValue: 1155, pnl: 155 })], now };
  const h = new Map([...histories("A", 100, 110), ...histories("B", 110, 115.5)]);
  near(buildHistoricalReportSeries(args, h, usd, new Map(), "alltime").at(-1)!.gain, 155);
  near(buildHistoricalReportSeries(args, h, usd, new Map(), "perf").at(-1)!.gain, 55);
  near(buildHistoricalReportSeries(args, h, usd, new Map(), "worth").at(-1)!.gain, 1155);
});

Deno.test("excluded buckets remove their fresh capital and retained sale cash including execution fees", () => {
  const args = { positions: [position("A", 100, 1002, 12)],
    orders: [trade("A", 100, 10, "2025-01-01", 2), trade("B", 50, 10, "2025-01-01", 1), trade("B", -50, 12, "2025-01-02", 2)],
    transactionBuckets: new Map([[JSON.stringify(["2025-01-01", "B", "USD"]), "__excluded"]]), bucketName: null,
    accountPerformances: [account({ fundingSource: "account_allocated", totalValue: 1698, pnl: 198, deposits: 1500, netContributions: 1500,
      fundingHistory: [{ date: "2025-01-01", amount: 2000 }, { date: "2025-01-01", amount: -500, allocation: true }],
      cashHistory: [{ date: "2025-01-01", currency: "USD", amount: 2000, type: "Deposit" }],
      cash: 498, ledgerCash: { USD: 498 }, sourceCashBalances: { USD: 1095 }, positionValue: 1200 })], now };
  near(buildHistoricalReportSeries(args, histories("A", 10, 12), usd, new Map(), "alltime").at(-1)!.gain, 198);
  near(buildHistoricalReportSeries(args, histories("A", 10, 12), usd, new Map(), "worth").at(-1)!.gain, 1698);
});

Deno.test("cash-funded shared buckets retain sold proceeds without using the owner's account cash", () => {
  const args = { positions: [], orders: [trade("A", 50, 10, "2025-01-01", 1), trade("A", -50, 12, "2025-01-02", 2)],
    transactionBuckets: new Map<string, string>(), bucketName: null,
    accountPerformances: [account({ fundingSource: "bucket_cash", deposits: 500, netContributions: 500, totalValue: 597, pnl: 97,
      fundingHistory: [{ date: "2025-01-01", amount: 500 }], cash: 597, ledgerCash: { USD: 597 }, cashHistory: undefined, positionValue: 0 })], now };
  near(buildHistoricalReportSeries(args, histories("A", 10, 12), usd, new Map(), "alltime").at(-1)!.gain, 97);
  near(buildHistoricalReportSeries(args, histories("A", 10, 12), usd, new Map(), "worth").at(-1)!.gain, 597);
});

Deno.test("trade-inclusive CSV cash is not charged twice, and incomplete ledgers are rejected", () => {
  const a = account({ cashHistoryIncludesTrades: true, cashHistory: [
    { date: "2025-01-01", currency: "USD", amount: 1000, type: "Deposit" },
    { date: "2025-01-01", currency: "USD", amount: -1000, type: "Buy" },
  ] });
  const args = { positions: [position("A", 100, 1000, 11)], orders: [trade("A", 100, 10)],
    transactionBuckets: new Map<string, string>(), bucketName: null, accountPerformances: [a], now };
  equal(buildHistoricalReportSeries(args, histories(), usd, new Map(), "alltime").at(-1)!.gain, 100);
  throws(() => buildHistoricalReportSeries({ ...args, accountPerformances: [{ ...a, cashHistory: undefined }] }, histories(), usd, new Map(), "alltime"), /Complete broker cash history/);
  throws(() => buildHistoricalReportSeries({ ...args, accountPerformances: [{ ...a, ledgerCash: { USD: 10 } }] }, histories(), usd, new Map(), "worth"), /cash does not reconcile/);
  deepStrictEqual(executionCash(trade("A", 2, 10, "2025-01-01", 1)), [{ currency: "USD", amount: -20 }, { currency: "USD", amount: -1 }]);
});

Deno.test("worth and lifetime reports use the same account valuation despite broker-vs-quote differences", async () => {
  const a = account({ totalValue: 1105, pnl: 105, cash: 10, ledgerCash: { USD: 10 }, positionValue: 1095 });
  const args = { positions: [position("A", 100, 1000, 11)], orders: [trade("A", 100, 10)], accountPerformances: [a] };
  const worth = await buildReportSnapshot(args, "worth");
  const lifetime = await buildReportSnapshot(args, "alltime");
  equal(worth.value, 1105);
  equal(worth.cash, 10);
  equal(worth.value - a.deposits + a.withdrawals, lifetime.value);
  equal((await buildReportSnapshot({ ...args, accountPerformances: [] }, "worth")).value, 1100);
});

Deno.test("cash-only accounts chart their ledger without inventing a position", async () => {
  const a = account({ deposits: 100, netContributions: 100, totalValue: 110, pnl: 10, cash: 110, ledgerCash: { USD: 110 }, positionValue: 0, investmentValue: 0,
    fundingHistory: [{ date: "2025-01-01", amount: 100 }], cashHistory: [{ date: "2025-01-01", currency: "USD", amount: 100, type: "Deposit" }, { date: "2025-01-02", currency: "USD", amount: 10, type: "Interest" }], reportedComponents: [] });
  const args = { positions: [], orders: [], accountPerformances: [a], transactionBuckets: new Map<string, string>(), bucketName: null, now };
  equal(buildHistoricalReportSeries(args, new Map(), usd, new Map(), "worth").at(-1)!.gain, 110);
  equal((await buildReportSnapshot(args, "worth")).value, 110);
  equal(buildHistoricalReportSeries(args, new Map(), usd, new Map(), "alltime").at(-1)!.gain, 10);
});
