import type { IntegrationAccountPerformance } from "../integrations/types.ts";
import { conversionFactor } from "../integrations/usd.ts";
import { requireReportNumber } from "../../utils/report_value.ts";
import { fetchConversionRates } from "../../utils/exchange_rates.ts";
import { accountTopups, nativeFundingFlows } from "./account_fx.ts";
import { contributedCapital } from "./contributed_capital.ts";
import { UserFacingError } from "../../utils/user_error.ts";

export async function accountWorth(holdings: number, selectedIds: Set<number>, accounts: IntegrationAccountPerformance[], currency: string, request: typeof fetch = fetch) {
  const rates = await fetchConversionRates(accounts.map(account => account.currency), currency, request);
  const ids = new Set(accounts.map(account => account.integrationId));
  if (ids.size !== accounts.length) throw new Error("Duplicate account valuation");
  const cash = accounts.reduce((sum, account) => sum + account.cash * conversionFactor(account.currency, rates), 0);
  const complete = accounts.length > 0 && [...selectedIds].every(id => ids.has(id));
  const value = complete ? accounts.reduce((sum, account) => sum + requireReportNumber(account.totalValue, "account value") * conversionFactor(account.currency, rates), 0)
    : holdings + cash;
  return { cash, value };
}

export function accountFunding(
  accounts: Parameters<typeof accountTopups>[0],
  selectedIntegrationIds: Set<number>,
  rates: ReadonlyMap<string, number>,
  currency = "USD",
) {
  const ids = new Set<number>();
  let deposits = 0;
  for (const account of accounts) {
    if (ids.has(account.integrationId)) throw new UserFacingError(`Bot counted account ${account.integrationId} twice. Ask admin to fix the report.`,
      { detail: "Duplicate account reconciliation" });
    ids.add(account.integrationId);
    const contributed = requireReportNumber(account.deposits, "account deposits");
    const withdrawn = requireReportNumber(account.withdrawals, "account withdrawals");
    if (contributed < 0 || withdrawn < 0) throw new UserFacingError(`Funding totals have wrong signs: deposits ${contributed}, withdrawals ${withdrawn}. Ask admin to check the import.`,
      { detail: "Account deposits and withdrawals must be nonnegative" });
    deposits += accountTopups([account]).reduce((sum, topup) => sum + topup.deposits *
      (topup.currency === currency ? 1 : conversionFactor(topup.currency, rates)), 0);
  }
  const complete = accounts.length > 0 && [...selectedIntegrationIds].every(id => ids.has(id));
  const dated = accounts.every(account => {
    if (!account.fundingHistory) return account.deposits === 0 && account.withdrawals === 0;
    const gross = account.fundingHistory.filter(flow => flow.allocation || flow.amount > 0).reduce((sum, flow) => sum + flow.amount, 0);
    const withdrawn = -account.fundingHistory.filter(flow => !flow.allocation && flow.amount < 0).reduce((sum, flow) => sum + flow.amount, 0);
    return Math.abs(gross - account.deposits) <= .02 && Math.abs(withdrawn - account.withdrawals) <= .02;
  });
  const hasWithdrawals = accounts.some(account => account.withdrawals > 0);
  const capital = !dated ? hasWithdrawals ? null : deposits : contributedCapital(accounts.flatMap(account =>
    nativeFundingFlows(account).map(flow => ({ date: flow.date, allocation: flow.allocation,
      amount: flow.nativeAmount * (flow.nativeCurrency === currency ? 1 : conversionFactor(flow.nativeCurrency, rates)) })))).capital;
  const reason = !complete
    ? "Lifetime return unavailable: complete account funding is required; filters and buckets have no allocated deposits or cash."
    : capital === null ? "Lifetime return unavailable: deposit and withdrawal dates are missing or incomplete."
    : capital <= 0 ? "Lifetime return unavailable: total deposits must be positive." : null;
  return { deposits, contributedCapital: capital, complete, reason };
}

// Net-account return is kept separate from stock performance and FX P/L.
export function accountReturn(
  accounts: IntegrationAccountPerformance[],
  selectedIntegrationIds: Set<number>,
  rates: ReadonlyMap<string, number>,
  currency = "USD",
) {
  const funding = accountFunding(accounts, selectedIntegrationIds, rates, currency);
  const pnl = accounts.reduce((sum, account) => sum +
    (requireReportNumber(account.totalValue, "account value") + account.withdrawals - account.deposits) *
    (account.currency === currency ? 1 : conversionFactor(account.currency, rates)), 0);
  return { ...funding, pnl, percentage: funding.reason ? null : pnl / funding.contributedCapital! * 100 };
}
