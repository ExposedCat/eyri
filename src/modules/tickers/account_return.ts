import type { IntegrationAccountPerformance } from "../integrations/types.ts";
import { conversionFactor } from "../integrations/usd.ts";
import { requireReportNumber } from "../../utils/report_value.ts";

export function accountReturn(
  accounts: IntegrationAccountPerformance[],
  selectedIntegrationIds: Set<number>,
  rates: ReadonlyMap<string, number>,
  currency = "USD",
) {
  const ids = new Set<number>();
  let deposits = 0, pnl = 0;
  for (const account of accounts) {
    if (ids.has(account.integrationId)) throw new Error("Duplicate account reconciliation");
    ids.add(account.integrationId);
    const factor = account.currency === currency ? 1 : conversionFactor(account.currency, rates);
    const contributed = requireReportNumber(account.deposits, "account deposits");
    const withdrawn = requireReportNumber(account.withdrawals, "account withdrawals");
    if (contributed < 0 || withdrawn < 0) throw new Error("Account deposits and withdrawals must be nonnegative");
    deposits += contributed * factor;
    pnl += (requireReportNumber(account.totalValue, "account value") + withdrawn - contributed) * factor;
  }
  const complete = accounts.length > 0 && [...selectedIntegrationIds].every(id => ids.has(id));
  const ambiguousTransfers = accounts.length > 1 && accounts.some(account =>
    account.fundingIncludesTransfers || account.withdrawals > 0 &&
      accounts.some(other => other.integrationId !== account.integrationId && other.deposits > 0)
  );
  const reason = !complete
    ? "Lifetime return unavailable: complete account funding is required; filters and buckets have no allocated deposits or cash."
    : ambiguousTransfers
    ? "Lifetime return unavailable: transfers between selected accounts must be identified and excluded from deposits."
    : deposits <= 0 ? "Lifetime return unavailable: total deposits must be positive." : null;
  return { percentage: reason ? null : pnl / deposits * 100, reason };
}
