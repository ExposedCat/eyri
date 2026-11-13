import { deepStrictEqual, equal, ok } from "node:assert/strict";
import { contributedCapital } from "./contributed_capital.ts";
import { accountFunding } from "./account_return.ts";
import { buildChartBenchmark } from "./chart_benchmark.ts";
import type { IntegrationAccountPerformance } from "../integrations/types.ts";
import type { IntegrationOrder, IntegrationPortfolioPosition } from "../integrations/types.ts";
import { Database } from "@db/sqlite";
import { loadAllTimeDataset, switchChartBenchmarks } from "./alltime_chart.ts";
import { buildIntegratedAllTimeReport } from "./portfolio.ts";
import { clipChartDataset } from "./chart_command.ts";

const events = (...amounts: number[]) => amounts.map((amount, i) => ({ date: `2025-01-${String(i + 1).padStart(2, "0")}`, amount }));
const account = (integrationId: number, amounts: number[], currency = "USD"): IntegrationAccountPerformance => {
  const fundingHistory = events(...amounts);
  const deposits = amounts.reduce((sum, amount) => sum + Math.max(0, amount), 0);
  const withdrawals = -amounts.reduce((sum, amount) => sum + Math.min(0, amount), 0);
  return { integrationId, currency, deposits, withdrawals, fundingHistory,
    totalValue: deposits - withdrawals, netContributions: deposits - withdrawals, pnl: 0, cash: 0, ledgerCash: {},
    positionValue: 0, investmentValue: 0, openedAt: new Date("2025-01-01"), historyThrough: new Date("2025-01-10") };
};

Deno.test("withdrawals accumulate in a negative balance; partial redeposits count only their eventual positive excess", () => {
  const flows = events(1000, -300, -200, 100, 250, 200);
  const original = structuredClone(flows);
  deepStrictEqual(contributedCapital(flows.slice(0, 3)), { capital: 1000, withdrawnBalance: -500 });
  deepStrictEqual(contributedCapital(flows.slice(0, 5)), { capital: 1000, withdrawnBalance: -150 });
  deepStrictEqual(contributedCapital(flows), { capital: 1050, withdrawnBalance: 0 });
  deepStrictEqual(contributedCapital(events(1000, -1000, 1000)), { capital: 1000, withdrawnBalance: 0 });
  deepStrictEqual(contributedCapital(events(500, -1000, 400)), { capital: 500, withdrawnBalance: -600 });
  deepStrictEqual(flows, original);
});

Deno.test("same-day out-and-back funding across accounts counts once regardless of account order", () => {
  const old = account(1, [4000, -3280]);
  const next = account(2, [0, 3280]);
  const input = structuredClone([old, next]);
  for (const accounts of [[old, next], [next, old]]) {
    const funding = accountFunding(accounts, new Set([1, 2]), new Map([["USD", 1]]));
    equal(funding.deposits, 7280);
    equal(funding.contributedCapital, 4000);
    equal(funding.reason, null);
  }
  deepStrictEqual([old, next], input);
});

Deno.test("funding is converted to the reporting currency before offsets; bucket allocations do not create withdrawal credit", () => {
  const eur = account(1, [1000, -400], "EUR"), usd = account(2, [0, 440]);
  const funding = accountFunding([usd, eur], new Set([1, 2]), new Map([["USD", 1], ["EUR", 1.1]]));
  ok(Math.abs(funding.contributedCapital! - 1100) < 1e-8);
  const flows = [...events(1000, 500), { date: "2025-01-01", amount: -300, allocation: true }];
  deepStrictEqual(contributedCapital(flows), { capital: 1200, withdrawnBalance: 0 });
});

Deno.test("an index sells and reinvests real cash while redeposits leave its contribution denominator unchanged", () => {
  const flows = events(1000, -500, 300, 250);
  const purchases = flows.map(flow => ({ date: flow.date, amountUsd: flow.amount }));
  const data = buildChartBenchmark({ symbol: "CSPX.L", currency: "USD", instrumentType: "ETF", splits: [],
    bars: [{ date: "2025-01-01", close: 100 }, { date: "2025-01-02", close: 110 },
      { date: "2025-01-03", close: 110 }, { date: "2025-01-04", close: 121 }] }, purchases, "2025-01-01", "2025-01-04");
  equal(data.points[1].contributedCapitalUsd, 1000);
  equal(data.points[2].contributedCapitalUsd, 1000);
  equal(data.points[3].contributedCapitalUsd, 1050);
  equal(data.points[3].depositsUsd, 1550);
  ok(Math.abs(data.points[3].value! - 1240) < 1e-8);
  ok(Math.abs(data.points[3].gain - 190) < 1e-8);
  ok(Math.abs(data.points[3].percentage - 190 / 1050 * 100) < 1e-8);
});

Deno.test("unknown funding order is reported when withdrawals exist, rather than guessing the recycled amount", () => {
  const unknown = { ...account(1, [1000, -500, 500]), fundingHistory: undefined };
  const funding = accountFunding([unknown], new Set([1]), new Map([["USD", 1]]));
  equal(funding.contributedCapital, null);
  ok(funding.reason?.includes("dates are missing or incomplete"));
});

Deno.test("text, historical chart, index switching and cropped windows share the same unrecycled capital without changing P/L", async () => {
  const db = new Database(":memory:");
  const funded = account(1, [1000, -500, 300, 250]);
  Object.assign(funded, { totalValue: 1227, positionValue: 847, investmentValue: 847, cash: 380, ledgerCash: { USD: 380 }, pnl: 177,
    cashHistory: funded.fundingHistory!.map(flow => ({ ...flow, currency: "USD", type: flow.amount < 0 ? "Withdrawal" : "Deposit" })) });
  const orders: IntegrationOrder[] = [[10, 100, 1], [-5, 110, 2], [2, 110, 3]].map(([quantity, price, day]) => ({
    integrationId: 1, integrationKind: "ibkr", account: "A", ticker: "A", currency: "USD", assetCategory: "STK",
    quantity, price, date: new Date(`2025-01-0${day}`), commission: { amount: 0, currency: "USD" },
  }));
  const position: IntegrationPortfolioPosition = { integrationId: 1, integrationKind: "ibkr", account: "A", ticker: "A", currency: "USD", assetCategory: "STK",
    amount: 7, totalInput: 720, averageUnitPrice: 720 / 7, currentPrice: 121, totalNow: 847, unrealizedPnl: 127, realizedPnl: 50,
    dailyPnl: 0, dailyPnlPercentage: 0, dailyPnlBaseline: 847, openedAt: new Date("2025-01-01") };
  const args = { positions: [position], orders, accountPerformances: [funded], transactionBuckets: new Map<string, string>(), bucketName: null,
    now: new Date("2025-01-04") };
  const history = { currency: "USD", splits: [], bars: [100, 110, 110, 121].map((close, i) => ({ date: `2025-01-0${i + 1}`, close })) };
  const cache = { resolve: async () => "A", get: async (symbol: string) => ({ ...history, symbol, instrumentType: symbol === "A" ? "EQUITY" : "ETF" }) };
  try {
    const original = structuredClone(funded);
    const report = await buildIntegratedAllTimeReport(args);
    equal(report!.total.change, 177);
    equal(report!.contributedCapital, 1050);
    equal(report!.totalReturnPercentage, 177 / 1050 * 100);
    equal(report!.currencyReturns[0].percentage, report!.totalReturnPercentage);
    const dataset = await loadAllTimeDataset(db, args, 1, "Test", cache as never);
    equal(dataset.points.at(-1)!.gain, 177);
    equal(dataset.points.at(-1)!.percentage, report!.totalReturnPercentage);
    equal(dataset.benchmarkFundingBasis!.at(-1)!.contributedCapital, 1050);
    equal(dataset.benchmarkFundingBasis!.at(-1)!.deposits, 1550);
    ok(Math.abs(dataset.benchmark!.points.at(-1)!.gain - 190) < 1e-8);
    ok(Math.abs(dataset.benchmark!.points.at(-1)!.percentage - 190 / 1050 * 100) < 1e-8);
    const cropped = clipChartDataset(dataset, "2025-01-03", "2025-01-04");
    const [switched] = await switchChartBenchmarks(db, [cropped], "momentum", cache);
    equal(switched.points[0].percentage, 10);
    ok(Math.abs(switched.benchmark!.points.at(-1)!.percentage - 190 / 1050 * 100) < 1e-8);
    deepStrictEqual(funded, original);
  } finally { db.close(); }
});
