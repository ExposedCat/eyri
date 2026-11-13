import type { IntegrationAccountPerformance, IntegrationOrder, IntegrationPortfolioPosition } from "../integrations/types.ts";
import { dayAfter, type PriceHistory } from "../market_data/history.ts";
import { historicalQuoteMultiplier } from "../market_data/options.ts";
import { historicalUsdFactor } from "../../utils/exchange_rates.ts";
import { getOrderTransactionKey, isDisplayableOrder } from "./portfolio.ts";
import { isCfdAllocation } from "./cfd_history.ts";
import type { ReportKind } from "./performance_command.ts";
import { accountFunding } from "./account_return.ts";
import { accountFxInputs, accountFxPnlAtDate, accountTopups, datedFxAccounts } from "./account_fx.ts";
import { userErrorMessage, UserFacingError } from "../../utils/user_error.ts";
import type { ChartPoint } from "./chart_points.ts";
import { HistoryMismatchError } from "./history_reconciliation.ts";

export type HistoricalReportArgs = {
  positions: IntegrationPortfolioPosition[];
  orders: IntegrationOrder[];
  transactionBuckets: Map<string, string>;
  bucketName: string | null;
  accountPerformances?: IntegrationAccountPerformance[];
  now?: Date;
  ignoreFx?: boolean;
  notes?: string[];
};
type Cash = Map<string, number>;
const add = (cash: Cash, currency: string, amount: number) => cash.set(currency, (cash.get(currency) ?? 0) + amount);
const dateOf = (date: Date) => date.toISOString().slice(0, 10);
const key = (item: { ticker: string; currency: string }) => JSON.stringify([item.ticker.trim().toUpperCase(), item.currency.trim().toUpperCase()]);
const lotKey = (order: IntegrationOrder) => JSON.stringify([order.integrationId, key(order)]);

export function executionCash(order: IntegrationOrder): { currency: string; amount: number }[] {
  if (order.price === null || !Number.isFinite(order.price)) throw new Error(`Missing execution cash price for ${order.ticker}`);
  const result: { currency: string; amount: number }[] = [];
  if (!isDisplayableOrder(order)) {
    const [base, quote] = order.ticker.toUpperCase().split(/[./]/);
    if (!/^[A-Z]{3}[./][A-Z]{3}$/.test(order.ticker.toUpperCase())) throw new Error(`Unsupported currency conversion ${order.ticker}`);
    if (order.price <= 0 || !Number.isFinite(order.quantity)) throw new Error(`Invalid FX execution rate for ${order.ticker}`);
    result.push({ currency: base, amount: order.quantity }, { currency: quote, amount: -order.quantity * order.price });
  } else if (order.walletImpact) {
    result.push({ currency: order.walletImpact.currency, amount: (order.quantity > 0 ? -1 : 1) * order.walletImpact.netValue });
  } else result.push({ currency: order.currency, amount: -order.quantity * order.price });
  if (order.commission) result.push({ currency: order.commission.currency, amount: order.commission.amount });
  return result;
}

// Replays actual cash in its original currency. Deposits never come from sale
// turnover; bucket contributions are the explicitly chosen fresh-cash model.
export function buildHistoricalReportSeries(
  args: HistoricalReportArgs,
  histories: Map<string, PriceHistory>,
  currentRates: ReadonlyMap<string, number>,
  historicalRates: ReadonlyMap<string, { date: string; factor: number }[]>,
  kind: Exclude<ReportKind, "dpnl">,
) {
  const accounts = args.accountPerformances ?? [];
  const note = (message: string) => { if (args.notes && !args.notes.includes(message)) args.notes.push(message); };
  let ignoreFx = args.ignoreFx ?? false;
  const brokerAccounts = accounts.filter(account => account.fundingSource !== "bucket_cash");
  const fundingAccounts = args.ignoreFx ? accounts.map(account => ({ ...account, cashHistory: undefined })) : accounts;
  const missingFundingDates = kind === "alltime" && accounts.some(account => !account.fundingHistory);
  if (missingFundingDates) { ignoreFx = true; note("Currency P/L excluded; deposit dates missing. Earlier percentages are gaps."); }
  if (kind === "worth" && brokerAccounts.some(account => !account.cashHistory)) {
    throw new Error("Complete broker cash history is required to reconstruct this chart. Refresh the integration ledger.");
  }
  if (kind !== "perf") for (const account of brokerAccounts) {
    // Gateway executions arrive before their completed Flex statement and may
    // not have fees yet. Only require fees in the completed ledger we validate;
    // recent points are provisional and the endpoint uses the live snapshot.
    if (!account.cashHistoryIncludesTrades && args.orders.some(order => order.integrationId === account.integrationId &&
      order.integrationKind === "ibkr" && !order.commission && (kind === "worth" || isDisplayableOrder(order)) &&
      dateOf(order.date) <= dateOf(account.historyThrough))) {
      throw new Error("IBKR historical cash requires Commission in the Flex trade query. Include commission amounts and refresh the trade history.");
    }
  }
  const orders = [...args.orders].sort((a, b) => +a.date - +b.date);
  const selected = (order: IntegrationOrder) => (args.transactionBuckets.get(getOrderTransactionKey(order)) ?? null) === args.bucketName;
  const purchases = orders.filter(isDisplayableOrder).filter(order => order.quantity > 0 && selected(order));
  const selectedInstruments = new Set(purchases.map(order => JSON.stringify([order.integrationId, key(order)])));
  const brokerIds = new Set(brokerAccounts.map(account => account.integrationId));
  let fundingReason: string | null;
  try { fundingReason = accountFunding(fundingAccounts, new Set([...purchases, ...args.positions].map(item => item.integrationId)), currentRates).reason; }
  catch (error) {
    if (!(error instanceof Error) || !/Currency conversion unavailable/.test(error.message)) throw error;
    fundingReason = "Funding conversion is missing.";
  }
  if (missingFundingDates) fundingReason = "Deposit dates are missing.";
  const fxOrders = orders.filter(order => !isDisplayableOrder(order));
  let fxInputs: ReturnType<typeof accountFxInputs> = [];
  if (!ignoreFx) try { fxInputs = accountFxInputs(accounts, fxOrders); }
  catch (error) { ignoreFx = true; note(`Currency P/L excluded: ${userErrorMessage(error)}`); }
  const fxCurrencies = new Set([...accounts.map(account => account.currency),
    ...accountTopups(fundingAccounts).map(topup => topup.currency),
    ...fxInputs.flatMap(input =>
      [...input.funding, ...input.conversions].map(event => event.currency)),
    ...(ignoreFx ? [] : fxOrders.flatMap(order => order.ticker.split(/[./]/).filter(currency => /^[A-Z]{3}$/.test(currency))))]);
  const dates = [...purchases.map(order => dateOf(order.date)),
    ...(kind === "perf" ? [] : accounts.flatMap(account => [
      ...(account.fundingHistory?.map(flow => flow.date) ?? []), ...(account.cashHistory?.map(flow => flow.date) ?? []),
    ]))].sort();
  if (!dates.length) throw new Error("No dated portfolio history to chart.");
  const first = dayAfter(dates[0], -1), last = dateOf(args.now ?? new Date());
  const factor = (currency: string, date: string) => {
    if (currency === "USD") return 1;
    try { if (!args.ignoreFx) return historicalUsdFactor(historicalRates, currency, date); }
    catch { /* Use a known conversion rate, never assume currencies are equal. */ }
    const known = currentRates.get(currency);
    if (known !== undefined && Number.isFinite(known) && known > 0) return known;
    throw new UserFacingError(`${currency} conversion rate is missing. Affected dates are gaps.`, { code: "chart_rate" });
  };
  const value = (cash: Cash, date: string) => [...cash].reduce((sum, [currency, amount]) =>
    sum + (amount === 0 ? 0 : amount * factor(currency, date)), 0);
  const fixedValue = (cash: Cash) => [...cash].reduce((sum, [currency, amount]) => sum + amount *
    (currentRates.get(currency) ?? factor(currency, last)), 0);
  const realCash = new Map(brokerAccounts.map(account => [account.integrationId, new Map<string, number>()]));
  let cashIncompleteFrom: string | undefined;
  const movements = (order: IntegrationOrder) => {
    try { return executionCash(order); }
    catch (error) {
      if (isDisplayableOrder(order)) throw error;
      const date = dateOf(order.date);
      cashIncompleteFrom = cashIncompleteFrom && cashIncompleteFrom < date ? cashIncompleteFrom : date;
      note(`Cash history has gaps from ${date}: an FX trade could not be read.`);
      return [];
    }
  };
  const events = (kind === "worth" ? brokerAccounts : []).flatMap(account => [
    ...(account.cashHistory ?? []).map(event => ({ ...event, integrationId: account.integrationId })),
    ...(account.cashHistoryIncludesTrades ? [] : orders.filter(order => order.integrationId === account.integrationId)
      .flatMap(order => movements(order).map(event => ({ ...event, date: dateOf(order.date), integrationId: account.integrationId })))),
  ]).sort((a, b) => a.date.localeCompare(b.date));
  const selectedCash = new Map<number, Cash>(), excludedCash = new Map<number, Cash>();
  const book = (map: Map<number, Cash>, order: IntegrationOrder, fraction: number, freshDeposit = false) => {
    const cash = map.get(order.integrationId) ?? new Map<string, number>();
    for (const movement of executionCash(order)) add(cash, movement.currency, movement.amount * fraction);
    if (freshDeposit) add(cash, order.currency, order.quantity * order.price! * fraction);
    map.set(order.integrationId, cash);
  };
  type Lot = { instrument: string; integrationId: number; quantity: number; unitCost: number; currency: string; selected: boolean; multiplier: number; atCost: boolean };
  const lots = new Map<string, Lot[]>(), prices = new Map<string, number>();
  const barIndices = new Map<string, number>(), splitIndices = new Map<string, number>();
  const realized = new Map<string, number>();
  const points: ChartPoint[] = [];
  let orderIndex = 0, eventIndex = 0;
  const replayStart = [first, ...orders.map(order => dateOf(order.date)), ...events.map(event => event.date)].sort()[0];
  for (let date = replayStart; date <= last; date = dayAfter(date)) {
    while (eventIndex < events.length && events[eventIndex].date <= date) {
      const event = events[eventIndex++];
      add(realCash.get(event.integrationId)!, event.currency, event.amount);
    }
    for (const [instrument, history] of histories) {
      let index = barIndices.get(instrument) ?? 0;
      while (index < history.bars.length && history.bars[index].date <= date) prices.set(instrument, history.bars[index++].close);
      barIndices.set(instrument, index);
      let splitIndex = splitIndices.get(instrument) ?? 0;
      while (splitIndex < history.splits.length && history.splits[splitIndex].date <= date) {
        const split = history.splits[splitIndex++];
        for (const list of lots.values()) for (const lot of list) if (lot.instrument === instrument) {
          lot.quantity *= split.ratio; lot.unitCost /= split.ratio;
        }
      }
      splitIndices.set(instrument, splitIndex);
    }
    while (orderIndex < orders.length && dateOf(orders[orderIndex].date) <= date) {
      const order = orders[orderIndex++];
      if (!isDisplayableOrder(order)) continue;
      if (!selectedInstruments.has(JSON.stringify([order.integrationId, key(order)]))) {
        if (brokerIds.has(order.integrationId)) book(excludedCash, order, 1, order.quantity > 0);
        continue;
      }
      const instrument = key(order), id = lotKey(order), list = lots.get(id) ?? [];
      if (order.quantity > 0) {
        const included = selected(order);
        let fee = 0;
        try { fee = order.commission ? order.commission.currency === order.currency ? order.commission.amount
          : order.commission.amount * factor(order.commission.currency, date) / factor(order.currency, date) : 0; }
        catch (error) {
          if (!(error instanceof UserFacingError) || error.code !== "chart_rate") throw error;
          note("Foreign-currency fees excluded: conversion rate missing.");
        }
        list.push({ instrument, integrationId: order.integrationId, quantity: order.quantity,
          unitCost: order.walletImpact ? order.walletImpact.netValue / order.quantity : order.price - fee / order.quantity,
          currency: order.walletImpact?.currency ?? order.currency, selected: included,
          multiplier: historicalQuoteMultiplier(args.positions.find(position => key(position) === instrument) ?? order), atCost: isCfdAllocation(order) });
        book(included ? selectedCash : excludedCash, order, 1, !included);
      } else {
        let left = -order.quantity;
        while (left > 1e-7 && list.length) {
          const lot = list[0], quantity = Math.min(left, lot.quantity), fraction = quantity / -order.quantity;
          book(lot.selected ? selectedCash : excludedCash, order, fraction);
          if (lot.selected) {
            const proceeds = order.walletImpact ? order.walletImpact.netValue * fraction
              : quantity * order.price + (order.commission?.currency === order.currency ? order.commission.amount * fraction : 0);
            add(realized, lot.currency, order.walletImpact?.realisedProfitLoss !== undefined
              ? order.walletImpact.realisedProfitLoss * fraction : proceeds - quantity * lot.unitCost);
          }
          lot.quantity -= quantity; left -= quantity;
          if (lot.quantity < 1e-7) list.shift();
        }
        if (left > 1e-7) throw new HistoryMismatchError(
          `${order.ticker}: sold ${-order.quantity}; earlier buys cover ${-order.quantity - left}. Refresh trade history.`,
          `Purchase history missing for sale of ${order.ticker}`);
      }
      lots.set(id, list);
    }
    if (date < first) continue;
    try {
    const positions = new Map<number, number>();
    let openValue = 0, openCost = 0;
    for (const list of lots.values()) for (const lot of list) {
      if (!lot.selected || lot.quantity < 1e-7) continue;
      const history = histories.get(lot.instrument), close = prices.get(lot.instrument);
      const cost = lot.quantity * lot.unitCost * factor(lot.currency, date);
      if (!lot.atCost && (close === undefined || !history || history.missing?.some(range => range.start <= date && date < range.end))) throw new UserFacingError(
        `${JSON.parse(lot.instrument)[0]} prices missing; affected dates are gaps.`, { code: "chart_price" });
      const marked = lot.atCost ? cost : lot.quantity * close! * lot.multiplier * factor(history!.currency, date);
      openValue += marked; openCost += cost;
      positions.set(lot.integrationId, (positions.get(lot.integrationId) ?? 0) + marked);
    }
    let gain: number, percentage: number | null;
    if (kind === "perf") {
      gain = openValue - openCost; percentage = openCost ? gain / openCost * 100 : 0;
    } else if (kind === "alltime") {
      const dayRates = new Map<string, number>();
      for (const currency of fxCurrencies) try { dayRates.set(currency, factor(currency, date)); }
      catch { ignoreFx = true; note("Currency P/L excluded: conversion rate missing."); }
      let fxPnl = 0;
      if (!ignoreFx) try { fxPnl = accountFxPnlAtDate(accounts, fxOrders, dayRates, date).reduce((sum, account) => sum + account.pnl, 0); }
      catch { ignoreFx = true; note("Currency P/L excluded: FX data could not be read."); }
      gain = openValue - openCost + value(realized, date) + fxPnl;
      let deposits = 0;
      try { deposits = accountFunding(datedFxAccounts(fundingAccounts, date),
        new Set([...purchases, ...args.positions].map(item => item.integrationId)), dayRates).contributedCapital ?? 0; }
      catch (error) {
        if (!(error instanceof Error) || !/Currency conversion unavailable/.test(error.message)) throw error;
      }
      percentage = fundingReason ? null : deposits > 0 ? gain / deposits * 100 : gain === 0 ? 0 : null;
    } else if (!accounts.length) {
      gain = openValue;
      percentage = null;
    } else {
      if (cashIncompleteFrom && date >= cashIncompleteFrom) throw new UserFacingError("Cash history has gaps: unreadable FX trade.", { code: "chart_rate" });
      let worth = 0;
      const covered = new Set<number>();
      for (const account of accounts) {
        covered.add(account.integrationId);
        const flows = (account.fundingHistory ?? []).filter(flow => flow.date <= date);
        const contributed = flows.filter(flow => flow.allocation || flow.amount > 0).reduce((sum, flow) => sum + flow.amount, 0);
        const fx = factor(account.currency, date);
        worth += positions.get(account.integrationId) ?? 0;
        if (account.fundingSource === "bucket_cash") {
          worth += contributed * fx + fixedValue(selectedCash.get(account.integrationId) ?? new Map());
        } else {
          worth += value(realCash.get(account.integrationId)!, date) - fixedValue(excludedCash.get(account.integrationId) ?? new Map());
        }
      }
      for (const [integrationId, marked] of positions) if (!covered.has(integrationId)) worth += marked;
      gain = worth;
      percentage = null;
    }
    points.push({ date, gain, percentage });
    } catch (error) {
      if (!(error instanceof UserFacingError) || !["chart_price", "chart_rate"].includes(error.code)) throw error;
      note(error.userMessage);
      points.push({ date, gain: null, percentage: null });
    }
  }
  if (kind === "worth" && !cashIncompleteFrom) for (const account of brokerAccounts) {
    const pendingFees = orders.some(order => order.integrationId === account.integrationId &&
      order.integrationKind === "ibkr" && !order.commission && dateOf(order.date) > dateOf(account.historyThrough));
    // A lagging statement cannot validate today's live cash. Still verify the
    // completed ledger, including its executions, against that statement.
    const actual = account.statementCash || pendingFees
      ? new Map<string, number>() : realCash.get(account.integrationId)!;
    if (account.statementCash || pendingFees) for (const event of events) {
      if (event.integrationId === account.integrationId && event.date <= dateOf(account.historyThrough)) {
        add(actual, event.currency, event.amount);
      }
    }
    // If cash still matches the completed statement, the funding reader may
    // not have marked it provisional (e.g. offsetting same-day executions).
    const expected = account.statementCash ?? account.sourceCashBalances ?? account.ledgerCash;
    for (const currency of new Set([...actual.keys(), ...Object.keys(expected)])) {
      if (Math.abs((actual.get(currency) ?? 0) - (expected[currency] ?? 0)) > .02) {
        throw new UserFacingError(`${currency} cash: history ${(actual.get(currency) ?? 0).toFixed(2)}, statement ${(expected[currency] ?? 0).toFixed(2)}. Refresh the ledger.`,
          { detail: `Historical ${currency} cash does not reconcile for integration ${account.integrationId}; the ledger must include every cash movement and execution fee.` });
      }
    }
  }
  const held = new Map<string, number>();
  for (const list of lots.values()) for (const lot of list) if (lot.selected) held.set(lot.instrument, (held.get(lot.instrument) ?? 0) + lot.quantity);
  const live = new Map<string, number>();
  for (const position of args.positions) live.set(key(position), (live.get(key(position)) ?? 0) + position.amount);
  for (const instrument of new Set([...held.keys(), ...live.keys()])) {
    if (Math.abs((held.get(instrument) ?? 0) - (live.get(instrument) ?? 0)) > 1e-6 * Math.max(1, live.get(instrument) ?? 0)) {
      throw new HistoryMismatchError(`${JSON.parse(instrument)[0]}: history ${held.get(instrument) ?? 0}, broker ${live.get(instrument) ?? 0} shares after refresh. Ask admin to check the missing trade or split.`,
        `Historical quantity does not reconcile for ${JSON.parse(instrument)[0]}`);
    }
  }
  return points;
}
