import { deepStrictEqual, equal, ok } from "node:assert/strict";
import type { IntegrationAccountPerformance, IntegrationOrder } from "../integrations/types.ts";
import type { PriceHistory } from "../market_data/history.ts";
import { benchmarkForKind } from "./benchmark_capital.ts";
import { buildChartBenchmark } from "./chart_benchmark.ts";
import { loadAllTimeDataset, switchChartBenchmarks } from "./alltime_chart.ts";
import { Database } from "@db/sqlite";

const near = (actual: number, expected: number) => ok(Math.abs(actual - expected) < 1e-8, `${actual} != ${expected}`);
const order = (ticker: string, quantity: number, price: number, day: number): IntegrationOrder => ({
  ticker, quantity, price, integrationId: 1, integrationKind: "ibkr", account: "A", assetCategory: "STK",
  currency: "USD", date: new Date(`2025-01-0${day}`), commission: { currency: "USD", amount: 0 },
});
const account = (deposit = 10): IntegrationAccountPerformance => ({ integrationId: 1, currency: "USD", totalValue: 100,
  pnl: 100 - deposit, deposits: deposit, withdrawals: 0, netContributions: deposit, cash: 0, ledgerCash: { USD: 0 },
  fundingHistory: [{ date: "2025-01-01", amount: deposit }], cashHistory: [{ date: "2025-01-01", amount: deposit, currency: "USD", type: "Deposit" }],
  openedAt: new Date("2025-01-01"), historyThrough: new Date("2025-01-03"), positionValue: 100, investmentValue: 100, reportedComponents: [{ currency: "USD", cost: 100, pnl: 0 }] });
const history: PriceHistory = { symbol: "CSPX.L", currency: "USD", instrumentType: "ETF", splits: [], bars: [
  { date: "2024-12-31", close: 10 }, { date: "2025-01-01", close: 10 }, { date: "2025-01-02", close: 11 }, { date: "2025-01-03", close: 12 },
] };

Deno.test("all report kinds display the same virtual portfolio using their own metric", () => {
  const benchmark = buildChartBenchmark(history, [{ date: "2025-01-01", amountUsd: 10, contributionUsd: 8, valuationCurrency: "CZK" }],
    "2025-01-01", "2025-01-03", "sp500", { CZK: [{ date: "2024-12-31", factor: 1 }, { date: "2025-01-03", factor: 1 }] });
  near(benchmarkForKind(benchmark, "perf").points.at(-1)!.gain, 2);
  near(benchmarkForKind(benchmark, "alltime").points.at(-1)!.gain, 4);
  near(benchmarkForKind(benchmark, "worth").points.at(-1)!.gain, 12);
});

Deno.test("every chart mode and asset filter invests all top-ups immediately, including idle cash, and freezes capital for index switching", async () => {
  const db = new Database(":memory:");
  const orders = [order("FIRST", 1, 10, 1), order("FIRST", -1, 100, 2), order("SECOND", 1, 100, 3)];
  const a = account(1000);
  a.cash = 1000; a.ledgerCash = { USD: 1000 }; a.totalValue = 1100; a.deposits = 1010;
  a.netContributions = 1010; a.pnl = 90;
  a.fundingHistory!.push({ date: "2025-01-02", amount: 10 });
  a.cashHistory!.push({ date: "2025-01-02", amount: 10, currency: "USD", type: "Deposit" });
  const positions = [{ integrationId: 1, integrationKind: "ibkr", account: "A", ticker: "SECOND", assetCategory: "STK", currency: "USD", amount: 1,
    averageUnitPrice: 100, totalInput: 100, currentPrice: 100, totalNow: 100, unrealizedPnl: 0, realizedPnl: 0, dailyPnl: 0, dailyPnlPercentage: 0,
    dailyPnlBaseline: 100, openedAt: new Date("2025-01-03") }];
  const benchmarkSource = { orders, accountPerformances: [a] };
  const cache = { resolve: (source: { ticker: string }) => Promise.resolve(source.ticker),
    get: (symbol: string) => Promise.resolve(symbol === "CSPX.L" || symbol === "IUMO.L" ? { ...history, symbol } : { ...history, symbol, instrumentType: "EQUITY", bars: history.bars.map(bar => ({ ...bar, close: symbol === "FIRST" && bar.date < "2025-01-02" ? 10 : 100 })) }) };
  try {
    for (const topup of [10, 1000]) {
      a.fundingHistory![0].amount = topup;
      a.cashHistory![0].amount = topup;
      a.deposits = a.netContributions = topup + 10;
      a.cash = a.ledgerCash!.USD = topup;
      a.totalValue = 100 + topup;
    for (const kind of ["perf", "alltime", "worth"] as const) {
      for (const filter of [null, "stocks", "options"] as const) {
        const dataset = await loadAllTimeDataset(db, { positions, orders, kind, filter, accountPerformances: filter ? [] : [a], benchmarkSource,
          transactionBuckets: new Map(), bucketName: null, now: new Date("2025-01-03") }, 1, "Person", cache as never);
        ok(dataset.benchmark);
        deepStrictEqual(dataset.benchmarkPurchases, [{ date: "2025-01-01", amountUsd: topup }, { date: "2025-01-02", amountUsd: 10 }]);
        const value = (topup / 10 + 10 / 11) * 12;
        near(dataset.benchmark.points.at(-1)!.gain, kind === "worth" ? value : value - topup - 10);
        const saved = JSON.parse(JSON.stringify(dataset));
        const [switched] = await switchChartBenchmarks(db, [saved], "momentum", cache);
        near(switched.benchmark!.points.at(-1)!.gain, dataset.benchmark.points.at(-1)!.gain);
        equal(switched.benchmark!.symbol, "IUMO.L");
        deepStrictEqual(switched.points, dataset.points);
      }
    }
    }
  } finally { db.close(); }
});
