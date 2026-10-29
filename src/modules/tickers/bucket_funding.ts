import type { IntegrationAccountPerformance, IntegrationOrder, IntegrationPortfolioPosition } from "../integrations/types.ts";
import { fetchUsdConversionRates } from "../../utils/exchange_rates.ts";
import { requireReportNumber } from "../../utils/report_value.ts";
import { portfolioValuations, usdFactor } from "../integrations/usd.ts";
import { buildIntegratedAllTimeReport, filterHistoryOrdersByBucket } from "./portfolio.ts";

export async function buildBucketCashAccounts(args: {
  positions: IntegrationPortfolioPosition[];
  orders: IntegrationOrder[];
  transactionBuckets: Map<string, string>;
  bucketName: string | null;
}, request: typeof fetch = fetch): Promise<IntegrationAccountPerformance[]> {
  const purchases = filterHistoryOrdersByBucket(args.orders, args.transactionBuckets, args.bucketName);
  const ids = new Set([...purchases, ...args.positions].map(item => item.integrationId));
  if (!ids.size) return [];
  const rates = await fetchUsdConversionRates([
    ...purchases.map(order => order.currency),
    ...args.positions.flatMap(position => portfolioValuations(position).map(value => value.currency)),
  ], request);
  const accounts: IntegrationAccountPerformance[] = [];
  for (const integrationId of ids) {
    const positions = args.positions.filter(position => position.integrationId === integrationId);
    const orders = args.orders.filter(order => order.integrationId === integrationId);
    const report = await buildIntegratedAllTimeReport({ ...args, positions, orders, request });
    if (!report) continue;
    const fundingHistory = purchases.filter(order => order.integrationId === integrationId).map(order => ({
      date: order.date.toISOString().slice(0, 10),
      amount: order.quantity * requireReportNumber(order.price, `${order.ticker} purchase price`) * usdFactor(order.currency, rates),
    }));
    if (fundingHistory.some(flow => !Number.isFinite(flow.amount) || flow.amount < 0)) {
      throw new Error("Invalid cash-funded bucket purchase");
    }
    const deposits = fundingHistory.reduce((sum, flow) => sum + flow.amount, 0);
    const pnl = requireReportNumber(report.total.change, "bucket P/L");
    const totalValue = deposits + pnl;
    const positionValue = positions.flatMap(portfolioValuations).reduce((sum, value) =>
      sum + requireReportNumber(value.totalNow, "bucket position value") * usdFactor(value.currency, rates), 0);
    const cash = totalValue - positionValue;
    accounts.push({
      integrationId,
      fundingSource: "bucket_cash",
      currency: "USD",
      fundingHistory,
      deposits,
      withdrawals: 0,
      netContributions: deposits,
      totalValue,
      pnl,
      cash,
      ledgerCash: { USD: cash },
      positionValue,
      investmentValue: positionValue,
      openedAt: report.total.openedAt ?? new Date(),
      historyThrough: new Date(),
      reportedComponents: report.performances.map(performance => ({
        currency: performance.currency,
        cost: requireReportNumber(performance.cost, "bucket cost"),
        pnl: requireReportNumber(performance.change, "bucket P/L"),
      })),
    });
  }
  return accounts;
}

export async function excludeBucketCapital(
  accounts: IntegrationAccountPerformance[],
  excluded: IntegrationAccountPerformance[],
  request: typeof fetch = fetch,
): Promise<IntegrationAccountPerformance[]> {
  if (!excluded.length) return accounts;
  const rates = await fetchUsdConversionRates(accounts.map(account => account.currency), request);
  return accounts.map(account => {
    const bucket = excluded.find(bucket => bucket.integrationId === account.integrationId);
    if (!bucket) return account;
    const factor = 1 / usdFactor(account.currency, rates);
    const deposits = account.deposits - bucket.deposits * factor;
    if (deposits < -.02) throw new Error("Excluded bucket capital exceeds account deposits.");
    const totalValue = account.totalValue - bucket.totalValue * factor;
    const cash = account.cash - bucket.cash * factor;
    return {
      ...account,
      fundingSource: "account_allocated",
      sourceCashBalances: account.sourceCashBalances ?? account.ledgerCash,
      deposits: Math.max(0, deposits),
      netContributions: Math.max(0, deposits) - account.withdrawals,
      totalValue,
      pnl: totalValue + account.withdrawals - Math.max(0, deposits),
      cash,
      ledgerCash: { [account.currency]: cash },
      positionValue: account.positionValue - bucket.positionValue * factor,
      investmentValue: account.investmentValue - bucket.positionValue * factor,
      fundingHistory: account.fundingHistory && [
        ...account.fundingHistory,
        ...(bucket.fundingHistory ?? []).map(flow => ({
          date: flow.date, amount: -flow.amount * factor, allocation: true,
        })),
      ].sort((first, second) => first.date.localeCompare(second.date)),
    };
  });
}
