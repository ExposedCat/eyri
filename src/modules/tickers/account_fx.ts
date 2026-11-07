import type { IntegrationAccountPerformance, IntegrationOrder } from "../integrations/types.ts";
import { conversionFactor } from "../integrations/usd.ts";
import { requireReportNumber } from "../../utils/report_value.ts";

const fundingTypes = new Set([
  "deposits/withdrawals", "deposits & withdrawals", "deposit", "withdrawal",
  "bank", "card", "cash", "intercompany", "internal_holding", "digital_assets",
]);

type FxAccount = Pick<IntegrationAccountPerformance, "integrationId" | "currency" | "fundingSource" |
  "cashHistory" | "cashHistoryIncludesTrades" | "fundingHistory" | "deposits" | "withdrawals" | "fundingIncludesTransfers">;
type Topup = { currency: string; deposits: number; withdrawals: number; source: "top_up" | "bucket" | "unknown" };

function nativeFunding(account: FxAccount) {
  return account.cashHistory?.filter(event => event.kind === "funding" ||
    !event.kind && fundingTypes.has(event.type.toLowerCase()));
}

export function nativeFundingFlows(account: FxAccount) {
  const funding = nativeFunding(account);
  const verified = account.fundingHistory?.filter(flow => !flow.allocation && !flow.provisional);
  const matched = funding && verified && funding.length === verified.length &&
    funding.every((event, index) => event.date === verified[index].date && Math.sign(event.amount) === Math.sign(verified[index].amount));
  let index = 0;
  return (account.fundingHistory ?? []).map(flow => {
    const event = !flow.allocation && !flow.provisional && matched ? funding[index++] : undefined;
    return { ...flow, nativeCurrency: event?.currency ?? account.currency, nativeAmount: event?.amount ?? flow.amount };
  });
}

// The parsers append native funding events and account-base funding flows in
// the same order. Pair them only when dates/signs agree; old or incomplete
// snapshots retain their existing account-currency denominator.
export function accountTopups(accounts: FxAccount[]) {
  return accounts.flatMap<Topup>(account => {
    const funding = nativeFunding(account);
    const flows = account.fundingHistory?.filter(flow => !flow.allocation && !flow.provisional);
    const allocations = (account.fundingHistory ?? []).filter(flow => flow.allocation)
      .reduce((sum, flow) => sum + flow.amount, 0);
    if (account.fundingSource === "bucket_cash" || !funding || !flows || funding.length !== flows.length ||
      funding.some((event, index) => event.date !== flows[index].date || Math.sign(event.amount) !== Math.sign(flows[index].amount))) {
      return [{ currency: account.currency, deposits: account.deposits, withdrawals: account.withdrawals,
        source: account.fundingSource === "bucket_cash" ? "bucket" as const : "unknown" as const }];
    }
    const gross = flows.reduce((sum, flow) => sum + Math.max(0, flow.amount), 0);
    const withdrawn = flows.reduce((sum, flow) => sum + Math.max(0, -flow.amount), 0);
    const pendingDeposits = (account.fundingHistory ?? []).filter(flow => flow.provisional)
      .reduce((sum, flow) => sum + Math.max(0, flow.amount), 0);
    const pendingWithdrawals = (account.fundingHistory ?? []).filter(flow => flow.provisional)
      .reduce((sum, flow) => sum + Math.max(0, -flow.amount), 0);
    const removed = Math.max(0, -allocations);
    if (Math.abs(gross + allocations - (account.deposits - pendingDeposits)) > .02 ||
      Math.abs(withdrawn - (account.withdrawals - pendingWithdrawals)) > .02 ||
      gross + .02 < removed || funding.every(event => event.currency === account.currency) &&
      Math.abs(funding.reduce((sum, event) => sum + event.amount, 0) -
        flows.reduce((sum, flow) => sum + flow.amount, 0)) > .02) {
      return [{ currency: account.currency, deposits: account.deposits, withdrawals: account.withdrawals, source: "unknown" as const }];
    }
    const share = gross ? Math.max(0, (gross - removed) / gross) : 1;
    return funding.map(event => ({ currency: event.currency,
      deposits: Math.max(0, event.amount) * share, withdrawals: Math.max(0, -event.amount), source: "top_up" as const }));
  });
}

export function proportionalCurrencyReturns(
  topups: ReturnType<typeof accountTopups>, pnl: number, rates: ReadonlyMap<string, number>,
) {
  if (topups.some(topup => topup.source === "unknown")) return [];
  const currencies = new Map<string, { currency: string; deposits: number; withdrawals: number; weight: number }>();
  for (const topup of topups) {
    const item = currencies.get(topup.currency) ?? { currency: topup.currency, deposits: 0, withdrawals: 0, weight: 0 };
    item.deposits += topup.deposits;
    item.withdrawals += topup.withdrawals;
    item.weight += topup.deposits * conversionFactor(topup.currency, rates);
    currencies.set(item.currency, item);
  }
  const items = [...currencies.values()];
  const totalWeight = items.reduce((sum, item) => sum + item.weight, 0);
  if (totalWeight <= 0) return [];
  // This is a hypothetical liquidation model, built from invested capital and
  // performance. Account NAV and live cash are deliberately not inputs.
  // Current-rate weights preserve the original native currency basket: with
  // no withdrawals, each top-up currency receives the same percentage return.
  const proceeds = pnl + items.reduce((sum, item) =>
    sum + (item.deposits - item.withdrawals) * conversionFactor(item.currency, rates), 0);
  return items.map(item => {
    const share = item.weight / totalWeight;
    const saleProceeds = proceeds * share / conversionFactor(item.currency, rates);
    const gain = saleProceeds + item.withdrawals - item.deposits;
    return { currency: item.currency, share, deposits: item.deposits, withdrawals: item.withdrawals,
      saleProceeds, pnl: gain, percentage: item.deposits > 0 ? gain / item.deposits * 100 : null };
  });
}

export function accountFxInputs(accounts: FxAccount[], fxOrders: IntegrationOrder[]) {
  return accounts.filter(account => account.fundingSource !== "bucket_cash").flatMap(account => {
    if (!account.cashHistory || !account.fundingHistory) return [];
    const funding = nativeFunding(account)!;
    // Older CSV snapshots combined conversion principal and fees. They cannot
    // supply an independent FX figure until rebuilt from the original export.
    if (account.cashHistoryIncludesTrades && account.cashHistory.some(event =>
      event.type === "Currency conversion" && !event.kind)) return [];
    const flows = account.fundingHistory.filter(flow => !flow.allocation && !flow.provisional);
    // Do not invent native deposits when only account-currency totals exist.
    if (flows.some(flow => !funding.some(event => event.date === flow.date))) return [];
    const allocations = account.fundingHistory.filter(flow => flow.allocation)
      .reduce((sum, flow) => sum + flow.amount, 0);
    const pending = account.fundingHistory.filter(flow => flow.provisional)
      .reduce((sum, flow) => sum + flow.amount, 0);
    const basis = account.deposits - account.withdrawals - allocations - pending;
    if (funding.every(event => event.currency === account.currency) &&
      Math.abs(funding.reduce((sum, event) => sum + event.amount, 0) - basis) > .02) return [];
    const conversions = account.cashHistoryIncludesTrades
      ? account.cashHistory.filter(event => event.kind === "fx")
        .map(event => ({ date: event.date, currency: event.currency, amount: event.amount }))
      : fxOrders.filter(order => order.integrationId === account.integrationId).flatMap(order => {
        const [base, quote] = order.ticker.toUpperCase().split(/[./]/);
        if (!/^[A-Z]{3}$/.test(base) || !/^[A-Z]{3}$/.test(quote)) {
          throw new Error(`Unsupported currency conversion ${order.ticker}`);
        }
        const price = requireReportNumber(order.price, `${order.ticker} FX execution rate`);
        if (price <= 0) throw new Error(`Invalid FX execution rate for ${order.ticker}`);
        const date = order.date.toISOString().slice(0, 10);
        // Commissions are costs, not currency principal or exchange-rate gains.
        return [{ date, currency: base, amount: order.quantity },
          { date, currency: quote, amount: -order.quantity * price }];
      });
    return [{ integrationId: account.integrationId, currency: account.currency, basis, funding, conversions }];
  });
}

export function accountFxPnl(inputs: ReturnType<typeof accountFxInputs>, rates: ReadonlyMap<string, number>) {
  return inputs.map(input => {
    const value = (events: { currency: string; amount: number }[]) => events.reduce((sum, event) =>
      sum + requireReportNumber(event.amount, "currency cash flow") * conversionFactor(event.currency, rates), 0);
    // Original top-up currencies are the reference basket. Merely holding a
    // deposited currency earns no FX P/L because the broker uses another base.
    // Both sides of actual conversions measure the move away from that basket.
    const funding = 0;
    const conversions = value(input.conversions);
    return { integrationId: input.integrationId, funding, conversions, pnl: funding + conversions };
  });
}

export function accountFxPnlAtDate(
  accounts: FxAccount[], fxOrders: IntegrationOrder[],
  rates: ReadonlyMap<string, number>, date: string,
) {
  const dated = datedFxAccounts(accounts, date);
  return accountFxPnl(accountFxInputs(dated, fxOrders.filter(order => order.date.toISOString().slice(0, 10) <= date)), rates);
}

export function datedFxAccounts(accounts: FxAccount[], date: string) {
  return accounts.map(account => {
    const fundingHistory = account.fundingHistory?.filter(flow => flow.date <= date);
    const deposits = (fundingHistory ?? []).filter(flow => flow.allocation || flow.amount > 0)
      .reduce((sum, flow) => sum + flow.amount, 0);
    const withdrawals = -(fundingHistory ?? []).filter(flow => !flow.allocation && flow.amount < 0)
      .reduce((sum, flow) => sum + flow.amount, 0);
    return { integrationId: account.integrationId, currency: account.currency,
      fundingSource: account.fundingSource, cashHistoryIncludesTrades: account.cashHistoryIncludesTrades,
      fundingIncludesTransfers: account.fundingIncludesTransfers,
      deposits, withdrawals, fundingHistory, cashHistory: account.cashHistory?.filter(event => event.date <= date) };
  });
}
