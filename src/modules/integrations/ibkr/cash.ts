import type { IntegrationAccountPerformance, IntegrationOrder } from "../types.ts";
import { fetchConversionRates } from "../../../utils/exchange_rates.ts";
import { conversionFactor } from "../usd.ts";

// The residual is unclassified cash, not verified income or a verified deposit.
// Neutralize it as temporary funding in the report only. The next Flex statement
// replaces it with classified events; none of these estimates are persisted.
export async function reconcileIbkrPendingCash(
  account: IntegrationAccountPerformance,
  orders: IntegrationOrder[],
  now = new Date(),
  request: typeof fetch = fetch,
): Promise<IntegrationAccountPerformance> {
  if (!account.statementCash) return account;
  const through = account.historyThrough.toISOString().slice(0, 10);
  const recent = orders.filter(order => order.integrationId === account.integrationId &&
    order.date.toISOString().slice(0, 10) > through);
  const expected = { ...account.statementCash };
  const add = (currency: string, amount: number) => expected[currency] = (expected[currency] ?? 0) + amount;
  for (const order of recent) {
    if (order.receipt !== "gift") {
      if (order.price === null || !Number.isFinite(order.price)) throw new Error(`Missing execution cash price for ${order.ticker}`);
      const [base, quote] = order.ticker.toUpperCase().split(/[./]/);
      if (["CASH", "FOREX"].includes(order.assetCategory?.toUpperCase() ?? "") ||
        /^[A-Z]{3}[./][A-Z]{3}$/.test(order.ticker)) {
        add(base, order.quantity);
        add(quote, -order.quantity * order.price);
      } else add(order.currency, -order.quantity * order.price);
    }
    if (order.commission) add(order.commission.currency, order.commission.amount);
  }
  const balances: Record<string, number> = {};
  for (const currency of new Set([...Object.keys(expected), ...Object.keys(account.ledgerCash)])) {
    const amount = (account.ledgerCash[currency] ?? 0) - (expected[currency] ?? 0);
    if (Math.abs(amount) > .02) balances[currency] = amount;
  }
  if (!recent.length && !Object.keys(balances).length) return account;
  const rates = await fetchConversionRates(Object.keys(balances), account.currency, request);
  const amount = Object.entries(balances).reduce((sum, [currency, value]) => sum + value * conversionFactor(currency, rates), 0);
  const date = now.toISOString().slice(0, 10);
  const deposits = account.deposits + Math.max(0, amount);
  const withdrawals = account.withdrawals + Math.max(0, -amount);
  const netContributions = deposits - withdrawals;
  return {
    ...account, fundingProvisional: true,
    pendingCashAdjustment: { date, amount, balances },
    deposits, withdrawals, netContributions,
    pnl: account.totalValue - netContributions,
    fundingHistory: account.fundingHistory && [...account.fundingHistory,
      ...(Math.abs(amount) > .005 ? [{ date, amount, provisional: true }] : [])],
    cashHistory: account.cashHistory && [...account.cashHistory,
      ...Object.entries(balances).map(([currency, amount]) => ({ date, currency, amount, type: "Unclassified cash (provisional)" }))],
  };
}
