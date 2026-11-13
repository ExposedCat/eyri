import { UserFacingError } from "../../utils/user_error.ts";

export type CapitalFlow = { date: string; amount: number; allocation?: boolean };

// All amounts use the same reporting currency. Broker histories carry dates,
// not a reliable cross-account order within a day, so withdrawals are applied
// before deposits on each date. An out-and-back pair never adds fresh capital.
export function contributedCapital(flows: CapitalFlow[]) {
  const dates = new Map<string, { deposits: number; withdrawals: number; allocations: number }>();
  for (const flow of flows) {
    const parsed = Date.parse(flow.date);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(flow.date) || !Number.isFinite(parsed) || new Date(parsed).toISOString().slice(0, 10) !== flow.date) {
      throw new UserFacingError(`Funding date “${flow.date}” is invalid. Refresh funding history.`);
    }
    if (!Number.isFinite(flow.amount)) throw new UserFacingError(`Funding amount on ${flow.date} is not a number. Refresh funding history.`);
    const day = dates.get(flow.date) ?? { deposits: 0, withdrawals: 0, allocations: 0 };
    if (flow.allocation) day.allocations += flow.amount;
    else if (flow.amount < 0) day.withdrawals -= flow.amount;
    else day.deposits += flow.amount;
    dates.set(flow.date, day);
  }
  let withdrawnBalance = 0, capital = 0;
  for (const [, day] of [...dates].sort(([a], [b]) => a.localeCompare(b))) {
    withdrawnBalance -= day.withdrawals;
    withdrawnBalance += day.deposits;
    if (withdrawnBalance > 1e-8) { capital += withdrawnBalance; withdrawnBalance = 0; }
    if (Math.abs(withdrawnBalance) < 1e-8) withdrawnBalance = 0;
    // Moving holdings into an excluded bucket removes capital from this view;
    // it is not a cash withdrawal and must not create redeposit credit.
    capital += day.allocations;
  }
  return { capital, withdrawnBalance };
}
