import type { IntegrationAccountPerformance, IntegrationOrder, IntegrationPortfolioPosition } from "../integrations/types.ts";
import { dayAfter, type PriceHistory } from "../market_data/history.ts";
import { historicalQuoteMultiplier } from "../market_data/options.ts";
import { historicalUsdFactor } from "../../utils/exchange_rates.ts";
import { conversionFactor } from "../integrations/usd.ts";
import { getOrderTransactionKey, isDisplayableOrder } from "./portfolio.ts";
import { isCfdAllocation } from "./cfd_history.ts";
import type { ReportKind } from "./performance_command.ts";
import { accountReturn } from "./account_return.ts";

export type HistoricalReportArgs = {
  positions: IntegrationPortfolioPosition[];
  orders: IntegrationOrder[];
  transactionBuckets: Map<string, string>;
  bucketName: string | null;
  accountPerformances?: IntegrationAccountPerformance[];
  now?: Date;
};
type Cash = Map<string, number>;
const add = (cash: Cash, currency: string, amount: number) => cash.set(currency, (cash.get(currency) ?? 0) + amount);
const dateOf = (date: Date) => date.toISOString().slice(0, 10);
const key = (item: { ticker: string; currency: string }) => JSON.stringify([item.ticker.trim().toUpperCase(), item.currency.trim().toUpperCase()]);
const lotKey = (order: IntegrationOrder) => JSON.stringify([order.integrationId, order.account.trim().toUpperCase(), key(order)]);

export function executionCash(order: IntegrationOrder): { currency: string; amount: number }[] {
  if (order.price === null || !Number.isFinite(order.price)) throw new Error(`Missing execution cash price for ${order.ticker}`);
  const result: { currency: string; amount: number }[] = [];
  if (!isDisplayableOrder(order)) {
    const [base, quote] = order.ticker.toUpperCase().split(/[./]/);
    if (!/^[A-Z]{3}$/.test(base) || !/^[A-Z]{3}$/.test(quote)) throw new Error(`Unsupported currency conversion ${order.ticker}`);
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
  const brokerAccounts = accounts.filter(account => account.fundingSource !== "bucket_cash");
  if (kind === "alltime" && accounts.some(account => !account.fundingHistory)) {
    throw new Error("Complete dated external funding is required to reconstruct lifetime returns.");
  }
  if (kind !== "perf" && brokerAccounts.some(account => !account.cashHistory)) {
    throw new Error("Complete broker cash history is required to reconstruct this chart. Refresh the integration ledger.");
  }
  if (kind !== "perf") for (const account of brokerAccounts) {
    if (!account.cashHistoryIncludesTrades && args.orders.some(order => order.integrationId === account.integrationId && order.integrationKind === "ibkr" && !order.commission)) {
      throw new Error("IBKR historical cash requires Commission in the Flex trade query. Include commission amounts and refresh the trade history.");
    }
  }
  const orders = [...args.orders].sort((a, b) => +a.date - +b.date);
  const selected = (order: IntegrationOrder) => (args.transactionBuckets.get(getOrderTransactionKey(order)) ?? null) === args.bucketName;
  const purchases = orders.filter(isDisplayableOrder).filter(order => order.quantity > 0 && selected(order));
  const selectedInstruments = new Set(purchases.map(order => JSON.stringify([order.integrationId, key(order)])));
  const brokerIds = new Set(brokerAccounts.map(account => account.integrationId));
  const fundingReason = accountReturn(accounts, new Set([...purchases, ...args.positions].map(item => item.integrationId)), currentRates).reason;
  const dates = [...purchases.map(order => dateOf(order.date)),
    ...(kind === "perf" ? [] : accounts.flatMap(account => [
      ...(account.fundingHistory?.map(flow => flow.date) ?? []), ...(account.cashHistory?.map(flow => flow.date) ?? []),
    ]))].sort();
  if (!dates.length) throw new Error("No dated portfolio history to chart.");
  const first = dayAfter(dates[0], -1), last = dateOf(args.now ?? new Date());
  const factor = (currency: string, date: string) => historicalUsdFactor(historicalRates, currency, date);
  const value = (cash: Cash, date: string) => [...cash].reduce((sum, [currency, amount]) =>
    sum + (amount === 0 ? 0 : amount * factor(currency, date)), 0);
  const fixedValue = (cash: Cash) => [...cash].reduce((sum, [currency, amount]) => sum + amount * conversionFactor(currency, currentRates), 0);
  const realCash = new Map(brokerAccounts.map(account => [account.integrationId, new Map<string, number>()]));
  const events = brokerAccounts.flatMap(account => [
    ...(account.cashHistory ?? []).map(event => ({ ...event, integrationId: account.integrationId })),
    ...(account.cashHistoryIncludesTrades ? [] : orders.filter(order => order.integrationId === account.integrationId)
      .flatMap(order => executionCash(order).map(event => ({ ...event, date: dateOf(order.date), integrationId: account.integrationId })))),
  ]).sort((a, b) => a.date.localeCompare(b.date));
  const selectedCash = new Map<number, Cash>(), excludedCash = new Map<number, Cash>();
  const book = (map: Map<number, Cash>, order: IntegrationOrder, fraction: number, freshDeposit = false) => {
    const cash = map.get(order.integrationId) ?? new Map<string, number>();
    for (const movement of executionCash(order)) add(cash, movement.currency, movement.amount * fraction);
    if (freshDeposit) add(cash, "USD", order.quantity * order.price! * fraction * conversionFactor(order.currency, currentRates));
    map.set(order.integrationId, cash);
  };
  type Lot = { instrument: string; integrationId: number; quantity: number; unitCost: number; currency: string; selected: boolean; multiplier: number; atCost: boolean };
  const lots = new Map<string, Lot[]>(), prices = new Map<string, number>();
  const barIndices = new Map<string, number>(), splitIndices = new Map<string, number>();
  const realized = new Map<string, number>();
  const points: { date: string; gain: number; percentage: number | null }[] = [];
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
        const fee = order.commission ? order.commission.amount * factor(order.commission.currency, date) / factor(order.currency, date) : 0;
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
        if (left > 1e-7) throw new Error(`Purchase history missing for sale of ${order.ticker}`);
      }
      lots.set(id, list);
    }
    if (date < first) continue;
    const positions = new Map<number, number>();
    let openValue = 0, openCost = 0;
    for (const list of lots.values()) for (const lot of list) {
      if (!lot.selected || lot.quantity < 1e-7) continue;
      const history = histories.get(lot.instrument), close = prices.get(lot.instrument);
      const cost = lot.quantity * lot.unitCost * factor(lot.currency, date);
      if (!lot.atCost && (close === undefined || !history)) throw new Error(`Historical close unavailable for ${JSON.parse(lot.instrument)[0]} on ${date}`);
      const marked = lot.atCost ? cost : lot.quantity * close! * lot.multiplier * factor(history!.currency, date);
      openValue += marked; openCost += cost;
      positions.set(lot.integrationId, (positions.get(lot.integrationId) ?? 0) + marked);
    }
    let gain: number, percentage: number | null;
    if (kind === "perf") {
      gain = openValue - openCost; percentage = openCost ? gain / openCost * 100 : 0;
    } else if (!accounts.length) {
      gain = kind === "worth" ? openValue : openValue - openCost + value(realized, date);
      percentage = null;
    } else {
      let worth = 0, deposits = 0, withdrawals = 0;
      const covered = new Set<number>();
      for (const account of accounts) {
        covered.add(account.integrationId);
        const flows = (account.fundingHistory ?? []).filter(flow => flow.date <= date);
        const contributed = flows.filter(flow => flow.allocation || flow.amount > 0).reduce((sum, flow) => sum + flow.amount, 0);
        const withdrawn = -flows.filter(flow => !flow.allocation && flow.amount < 0).reduce((sum, flow) => sum + flow.amount, 0);
        const fx = factor(account.currency, date);
        deposits += contributed * fx; withdrawals += withdrawn * fx;
        worth += positions.get(account.integrationId) ?? 0;
        if (account.fundingSource === "bucket_cash") {
          worth += contributed * fx + fixedValue(selectedCash.get(account.integrationId) ?? new Map());
        } else {
          worth += value(realCash.get(account.integrationId)!, date) - fixedValue(excludedCash.get(account.integrationId) ?? new Map());
        }
      }
      for (const [integrationId, marked] of positions) if (!covered.has(integrationId)) worth += marked;
      gain = kind === "worth" ? worth : worth + withdrawals - deposits;
      percentage = kind === "worth" || fundingReason || [...positions.keys()].some(id => !covered.has(id)) ? null
        : deposits > 0 ? gain / deposits * 100 : gain === 0 ? 0 : null;
    }
    points.push({ date, gain, percentage });
  }
  if (kind !== "perf") for (const account of brokerAccounts) {
    const actual = realCash.get(account.integrationId)!, expected = account.sourceCashBalances ?? account.ledgerCash;
    for (const currency of new Set([...actual.keys(), ...Object.keys(expected)])) {
      if (Math.abs((actual.get(currency) ?? 0) - (expected[currency] ?? 0)) > .02) {
        throw new Error(`Historical ${currency} cash does not reconcile for integration ${account.integrationId}; the ledger must include every cash movement and execution fee.`);
      }
    }
  }
  const held = new Map<string, number>();
  for (const list of lots.values()) for (const lot of list) if (lot.selected) held.set(lot.instrument, (held.get(lot.instrument) ?? 0) + lot.quantity);
  const live = new Map<string, number>();
  for (const position of args.positions) live.set(key(position), (live.get(key(position)) ?? 0) + position.amount);
  for (const instrument of new Set([...held.keys(), ...live.keys()])) {
    if (Math.abs((held.get(instrument) ?? 0) - (live.get(instrument) ?? 0)) > 1e-6 * Math.max(1, live.get(instrument) ?? 0)) {
      throw new Error(`Historical quantity does not reconcile for ${JSON.parse(instrument)[0]}`);
    }
  }
  return points;
}
