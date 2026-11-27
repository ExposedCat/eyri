import { accountFxPnlAtDate, accountTopups, datedFxAccounts, nativeFundingFlows } from "./account_fx.ts";
import { accountFunding } from "./account_return.ts";
import { UserFacingError, userErrorMessage } from "../../utils/user_error.ts";
import type { ChartPoint } from "./chart_points.ts";
import { loadChartFx } from "./chart_fx.ts";
import { accountFxInputs } from "./account_fx.ts";
import { buildHistoricalReportSeries, executionCash } from "./historical_report.ts";
import { buildReportSnapshot } from "./report.ts";
import type { ReportKind, ReportFilter } from "./performance_command.ts";
import { benchmarkForKind, benchmarkWithFundingBasis, type BenchmarkSource, type FundingBasisPoint } from "./benchmark_capital.ts";
import { buildChartGifts, isGiftReceipt, withChartGifts, type ChartGiftPoint } from "./chart_gifts.ts";
import type { Database } from "../database/setup.ts";
import { renderAllTimeDatasets } from "./alltime_chart_renderer.ts";
import {
  type BenchmarkPurchase,
  type BenchmarkValuations,
  type ChartBenchmark,
  type ChartBenchmarkIndex,
  chartBenchmarkIndex,
  loadChartBenchmark,
} from "./chart_benchmark.ts";
import { historicalQuoteMultiplier, yahooOptionContract } from "../market_data/options.ts";
import { DATABENTO_PREFIX } from "../market_data/databento.ts";
import { VONTOBEL_PREFIX, VontobelHistoryError } from "../market_data/vontobel.ts";
import {
  MORGAN_STANLEY_PREFIX,
  MorganStanleyHistoryError,
} from "../market_data/morgan_stanley.ts";
import type { FailedHistory } from "../market_data/errors.ts";
import { defaultYahooSymbols } from "../market_data/symbols.ts";
import {
  adjustOrderForCorporateActions,
  currentStockTicker,
  optionHistorySegments,
} from "../market_data/corporate_actions.ts";
import { readYahooMapping } from "../market_data/mappings.ts";
import type {
  IntegrationOrder,
  IntegrationPortfolioPosition,
  IntegrationAccountPerformance,
} from "../integrations/types.ts";
import { usdFactor } from "../integrations/usd.ts";
import { historicalUsdFactor } from "../../utils/exchange_rates.ts";
import { HistoryMismatchError } from "./history_reconciliation.ts";
import { portfolioPositionCurrencies, portfolioValuations } from "../integrations/usd.ts";
import { isCfdAllocation } from "./cfd_history.ts";
import {
  dayAfter,
  type PriceHistory,
  sharedYahooHistoryCache,
} from "../market_data/yahoo.ts";
import {
  buildIntegratedSoldPerformances,
  getOrderTransactionKey,
  isDisplayableOrder,
} from "./portfolio.ts";

export type AllTimePoint = ChartPoint;
type CompleteAllTimePoint = ChartPoint & { gain: number };
export type AllTimeDataset = {
  fundingReturnVersion?: 6;
  kind?: Exclude<ReportKind, "dpnl">;
  filter?: ReportFilter;
  notes?: string[];
  userId: number;
  label: string;
  bucketName: string | null;
  points: AllTimePoint[];
  purchaseDates?: string[];
  dateRange?: { start: string; end: string };
  // A price-feed failure may leave inputs ready while the index is absent.
  benchmark?: ChartBenchmark;
  benchmarkIndex?: ChartBenchmarkIndex;
  benchmarkInputsReady?: boolean;
  benchmarkPurchases?: BenchmarkPurchase[];
  benchmarkValuations?: BenchmarkValuations;
  benchmarkFundingBasis?: FundingBasisPoint[];
  benchmarkGifts?: ChartGiftPoint[];
  benchmarkSnapshots?: Partial<Record<ChartBenchmarkIndex, ChartBenchmark>>;
  // Points remain USD snapshots; only single-chart monetary labels use these.
  displayCurrency?: string;
  displayRate?: number;
};
type Args = {
  benchmarkSource?: BenchmarkSource;
  kind?: Exclude<ReportKind, "dpnl">;
  filter?: ReportFilter;
  positions: IntegrationPortfolioPosition[];
  orders: IntegrationOrder[];
  transactionBuckets: Map<string, string>;
  bucketName: string | null;
  now?: Date;
  accountPerformances?: IntegrationAccountPerformance[];
};
const EPSILON = 1e-7;
export const instrumentKey = (item: { ticker: string; currency: string }) =>
  JSON.stringify([
    item.ticker.trim().toUpperCase(),
    item.currency.trim().toUpperCase(),
  ]);
const lotKey = (order: IntegrationOrder) =>
  JSON.stringify([
    order.integrationId,
    instrumentKey(order),
  ]);
const dateOf = (date: Date) => date.toISOString().slice(0, 10);

export function selectedChartOrders(args: Args) {
  return args.orders.filter(isDisplayableOrder).filter((order) =>
    order.quantity > 0 &&
    (args.transactionBuckets.get(getOrderTransactionKey(order)) ?? null) ===
      args.bucketName
  );
}

function withFreeStockPurchases(args: Args): Args {
  const positionKey = (item: Pick<IntegrationOrder, "integrationId" | "ticker" | "currency">) =>
    JSON.stringify([item.integrationId, instrumentKey(item)]);
  const purchased = new Set(
    args.orders.filter((o) => o.quantity > 0).map(positionKey),
  );
  const orders = [...args.orders];
  const transactionBuckets = new Map(args.transactionBuckets);
  const adjustments = new Map<
    number,
    { currency: string; cost: number; pnl: number }[]
  >();
  const positions = args.positions.map((position) => {
    const category = position.assetCategory?.trim().toUpperCase();
    if (
      position.amount <= 0 || purchased.has(positionKey(position)) ||
      (category && category !== "STK" && category !== "STOCK") ||
      yahooOptionContract(position.ticker) || isCfdAllocation(position)
    ) return position;

    // The acquisition date is unknown. Record the assumption only at the
    // current endpoint, without inventing earlier ownership or broker trades.
    const transactionKey = JSON.stringify([
      "free-stock",
      position.integrationId,
      position.account,
      instrumentKey(position),
    ]);
    orders.push({
      integrationId: position.integrationId,
      integrationKind: position.integrationKind,
      account: position.account,
      ticker: position.ticker,
      currency: position.currency,
      assetCategory: position.assetCategory ?? "STK",
      date: new Date(dateOf(args.now ?? new Date())),
      quantity: position.amount,
      price: 0,
      receipt: "gift",
      commission: { amount: 0, currency: position.currency },
      transactionKey,
      yahooSymbol: position.yahooSymbol,
      isin: position.isin,
      historicalPriceMultiplier: position.historicalPriceMultiplier,
    });
    if (args.bucketName !== null) {
      transactionBuckets.set(transactionKey, args.bucketName);
    }
    const components = adjustments.get(position.integrationId) ?? [];
    for (const valuation of portfolioValuations(position)) {
      const cost = valuation.totalInput ?? 0;
      components.push({ currency: valuation.currency, cost: -cost, pnl: cost });
    }
    adjustments.set(position.integrationId, components);
    return {
      ...position,
      averageUnitPrice: 0,
      totalInput: 0,
      unrealizedPnl: position.totalNow,
      ...(position.brokerValuations
        ? {
          brokerValuations: position.brokerValuations.map((v) => ({
            ...v,
            totalInput: 0,
            unrealizedPnl: v.totalNow,
          })),
        }
        : {}),
    };
  });
  return {
    ...args,
    positions,
    orders,
    transactionBuckets,
    accountPerformances: args.accountPerformances?.map((account) => ({
      ...account,
      // Funding-based account returns still reconcile against the same snapshot.
      reportedComponents: account.reportedComponents && [
        ...account.reportedComponents,
        ...(adjustments.get(account.integrationId) ?? []),
      ],
    })),
  };
}

export function buildAllTimeSeries(
  args: Args,
  histories: Map<string, PriceHistory>,
  rates: ReadonlyMap<string, number>,
): CompleteAllTimePoint[] {
  args = withFreeStockPurchases(args);
  const now = args.now ?? new Date();
  const selected = selectedChartOrders(args);
  if (!selected.length) {
    throw new Error(
      "No purchase history for this chart. Complete broker order history is required.",
    );
  }
  const selectedKeys = new Set(selected.map(instrumentKey));
  for (const position of args.positions) {
    if (position.amount < 0) {
      throw new Error(
        `Historical short positions are not supported for ${position.ticker}.`,
      );
    }
    if (!selectedKeys.has(instrumentKey(position))) {
      throw new Error(`Purchase history is missing for ${position.ticker}.`);
    }
  }
  const orders = args.orders.filter(isDisplayableOrder).sort((a, b) =>
    +a.date - +b.date
  );
  const first = selected.map((o) => dateOf(o.date)).sort()[0];
  const last = dateOf(now);
  type Lot = {
    key: string;
    quantity: number;
    price: number;
    selected: boolean;
    currency: string;
    quoteMultiplier: number;
    atCost: boolean;
  };
  const lots = new Map<string, Lot[]>();
  const prices = new Map<string, number>();
  const barIndices = new Map<string, number>();
  const splitIndices = new Map<string, number>();
  type Totals = { cost: number; gain: number };
  const addTotals = (
    totals: Map<string, Totals>,
    currency: string,
    cost: number,
    gain: number,
  ) => {
    const key = currency.trim().toUpperCase();
    const current = totals.get(key) ?? { cost: 0, gain: 0 };
    totals.set(key, { cost: current.cost + cost, gain: current.gain + gain });
  };
  const accounts = args.accountPerformances ?? [];
  const cashFunded = accounts.length > 0 && accounts.every(account => account.fundingSource === "bucket_cash");
  const pointInUsd = (date: string, totals: Map<string, Totals>): CompleteAllTimePoint => {
    let gain = 0;
    for (const [currency, native] of totals) {
      const factor = usdFactor(currency, rates);
      gain += native.gain * factor;
    }
    gain += accountFxPnlAtDate(accounts, args.orders.filter(order => !isDisplayableOrder(order)), rates, date)
      .reduce((sum, account) => sum + account.pnl, 0);
    const deposits = cashFunded ? accounts.reduce((sum, account) =>
      sum + (account.fundingHistory ?? []).filter(flow => flow.date <= date)
        .reduce((amount, flow) => amount + flow.amount, 0) * usdFactor(account.currency, rates), 0) : 0;
    const percentage = !cashFunded ? null : deposits > 0 ? gain / deposits * 100 : gain === 0 ? 0 : null;
    return { date, percentage, gain };
  };
  const realized = new Map<string, Totals>();
  const nativeWalletRealized = new Map<string, Totals>();
  let orderIndex = 0;
  const points: CompleteAllTimePoint[] = [{
    date: dayAfter(first, -1),
    percentage: cashFunded ? 0 : null,
    gain: 0,
  }];
  // Replay earlier unselected lots too: sales must consume them before bucket lots.
  const replayStart = orders.length ? dateOf(orders[0].date) : first;
  for (let date = replayStart; date <= last; date = dayAfter(date)) {
    for (const [key, history] of histories) {
      let index = barIndices.get(key) ?? 0;
      while (index < history.bars.length && history.bars[index].date <= date) {
        prices.set(key, history.bars[index].close);
        index++;
      }
      barIndices.set(key, index);
      let splitIndex = splitIndices.get(key) ?? 0;
      while (
        splitIndex < history.splits.length &&
        history.splits[splitIndex].date <= date
      ) {
        const split = history.splits[splitIndex];
        for (const accountLots of lots.values()) {
          for (const lot of accountLots) {
            if (lot.key === key) {
              lot.quantity *= split.ratio;
              lot.price /= split.ratio;
            }
          }
        }
        splitIndex++;
      }
      splitIndices.set(key, splitIndex);
    }
    while (
      orderIndex < orders.length && dateOf(orders[orderIndex].date) <= date
    ) {
      const order = orders[orderIndex++];
      if (
        !Number.isFinite(order.quantity) || !Number.isFinite(order.price) ||
        order.price < 0
      ) throw new Error(`Invalid trade for ${order.ticker}.`);
      const key = instrumentKey(order);
      const accountKey = lotKey(order);
      const accountLots = lots.get(accountKey) ?? [];
      if (order.quantity > 0) {
        accountLots.push({
          key,
          quantity: order.quantity,
          price: order.price - (order.commission?.currency === order.currency ? order.commission.amount / order.quantity : 0),
          selected:
            (args.transactionBuckets.get(getOrderTransactionKey(order)) ??
              null) === args.bucketName,
          currency: order.currency,
          atCost: isCfdAllocation(order),
          quoteMultiplier: historicalQuoteMultiplier(
            args.positions.find((p) =>
              p.integrationId === order.integrationId &&
              instrumentKey(p) === key
            ) ?? order,
          ),
        });
      } else {
        let remaining = -order.quantity;
        while (remaining > EPSILON && accountLots.length) {
          const lot = accountLots[0];
          const quantity = Math.min(remaining, lot.quantity);
          if (lot.selected) {
            const gain = quantity * (order.price - lot.price) +
              (order.commission?.currency === order.currency ? order.commission.amount * quantity / -order.quantity : 0);
            addTotals(
              realized,
              lot.currency,
              quantity * lot.price,
              gain,
            );
            if (order.walletImpact) addTotals(nativeWalletRealized, lot.currency,
              quantity * lot.price, gain);
          }
          remaining -= quantity;
          lot.quantity -= quantity;
          if (lot.quantity < EPSILON) accountLots.shift();
        }
        if (remaining > EPSILON && selectedKeys.has(key)) {
          throw new Error(
            `Incomplete purchase history for ${order.ticker}; a sale has no matching FIFO lot.`,
          );
        }
      }
      lots.set(accountKey, accountLots);
    }
    if (date < first) continue;
    const totals = new Map(realized);
    for (const accountLots of lots.values()) {
      for (const lot of accountLots) {
        if (!lot.selected || lot.quantity < EPSILON) continue;
        const basis = lot.quantity * lot.price;
        if (lot.atCost) {
          addTotals(totals, lot.currency, basis, 0);
          continue;
        }
        const close = prices.get(lot.key), history = histories.get(lot.key);
        if (close === undefined || !history) {
          throw new Error(
            `Historical closing price unavailable on ${date} for ${
              JSON.parse(lot.key)[0]
            }.`,
          );
        }
        const value = lot.quantity * close * lot.quoteMultiplier;
        if (
          history.currency.trim().toUpperCase() ===
            lot.currency.trim().toUpperCase()
        ) {
          addTotals(totals, lot.currency, basis, value - basis);
        } else {
          // Alternate listings can use another currency (e.g. GBP vs GBX).
          // Keep each monetary contribution in its own currency until reporting.
          addTotals(totals, lot.currency, basis, -basis);
          addTotals(totals, history.currency, 0, value);
        }
      }
    }
    points.push(pointInUsd(date, totals));
  }
  // Reconcile the reconstructed quantities before anchoring to broker book cost.
  // This catches transfers, truncated history, and unsupported ticker changes.
  const quantities = new Map<string, number>();
  for (const accountLots of lots.values()) {
    for (const lot of accountLots) {
      if (lot.selected) {
        quantities.set(lot.key, (quantities.get(lot.key) ?? 0) + lot.quantity);
      }
    }
  }
  const live = new Map<string, number>();
  for (const position of args.positions) {
    live.set(
      instrumentKey(position),
      (live.get(instrumentKey(position)) ?? 0) + position.amount,
    );
  }
  for (const key of new Set([...quantities.keys(), ...live.keys()])) {
    const expected = live.get(key) ?? 0, actual = quantities.get(key) ?? 0;
    if (Math.abs(expected - actual) > EPSILON * Math.max(1, expected, actual)) {
      throw new Error(
        `Cannot build ${JSON.parse(key)[0]} chart: trade history shows ${actual} held, but the broker reports ${expected}.`,
      );
    }
  }
  // Use exactly /alltime's current + FIFO-sold cost/P&L for the live endpoint.
  const totals = new Map<string, Totals>();
  for (const p of args.positions) {
    if (p.brokerValuations) {
      for (const valuation of portfolioValuations(p)) {
        if (valuation.totalInput === null || valuation.unrealizedPnl === null) {
          throw new Error(`Current price or book cost unavailable for ${p.ticker}.`);
        }
        addTotals(totals, valuation.currency, valuation.totalInput, valuation.unrealizedPnl);
      }
      continue;
    }
    if (
      p.currentPrice === null || p.totalInput === null ||
      p.averageUnitPrice === null
    ) {
      throw new Error(
        `Current price or book cost unavailable for ${p.ticker}.`,
      );
    }
    addTotals(
      totals,
      p.currency,
      p.totalInput,
      p.currentPrice * p.amount - p.totalInput,
    );
  }
  const hasSplits = [...histories.values()].some((h) => h.splits.length);
  // Native FIFO already has /alltime's semantics. Split-aware reconstruction is
  // needed when historical fills use pre-split units; its realized values are canonical then.
  if (hasSplits) {
    for (const [currency, native] of realized) {
      addTotals(totals, currency, native.cost, native.gain);
    }
    // Broker wallet results remain canonical even when chart history contains
    // splits. Replace only those fills, retaining split-aware native results
    // for other brokers.
    for (const [currency, native] of nativeWalletRealized) addTotals(totals, currency, -native.cost, -native.gain);
    for (const p of buildIntegratedSoldPerformances(args.orders.filter(o => o.quantity > 0 || o.walletImpact), args.transactionBuckets, args.bucketName)) {
      addTotals(totals, p.currency, p.cost, p.realizedPnl);
    }
  } else {
    for (
      const p of buildIntegratedSoldPerformances(
        args.orders,
        args.transactionBuckets,
        args.bucketName,
      )
    ) {
      addTotals(totals, p.currency, p.cost, p.realizedPnl);
    }
  }
  const selectedIntegrationIds = new Set([...args.positions, ...selected].map(item => item.integrationId));
  const funding = accountFunding(args.accountPerformances ?? [], selectedIntegrationIds, rates);
  const endpoint = pointInUsd(last, totals);
  points[points.length - 1] = { ...endpoint, gain: endpoint.gain, percentage: funding.reason ? null : endpoint.gain / funding.contributedCapital! * 100 };
  return points;
}

export function historyCache(db: Database) {
  return sharedYahooHistoryCache(db);
}
export function ensureChartSchema(db: Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS alltime_series_cache (cache_key TEXT PRIMARY KEY, payload TEXT NOT NULL, created_at REAL NOT NULL);
    CREATE TABLE IF NOT EXISTS alltime_render_cache (cache_key TEXT PRIMARY KEY, png BLOB NOT NULL, created_at REAL NOT NULL);
    CREATE TABLE IF NOT EXISTS alltime_chart_sessions (id TEXT PRIMARY KEY, chat_id TEXT NOT NULL, message_id TEXT, datasets TEXT NOT NULL);
  `);
}
export async function hash(value: unknown) {
  return [
    ...new Uint8Array(
      await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(JSON.stringify(value)),
      ),
    ),
  ].map((n) => n.toString(16).padStart(2, "0")).join("");
}

export async function loadAllTimeDataset(
  db: Database,
  args: Args,
  userId: number,
  label: string,
  cache = historyCache(db),
  request: typeof fetch = fetch,
): Promise<AllTimeDataset> {
  ensureChartSchema(db);
  const kind = args.kind ?? "alltime";
  const notes: string[] = [];
  args = { ...args, kind };
  const reportArgs = args;
  const through = dateOf(args.now ?? new Date());
  args = {
    ...args,
    orders: args.orders.map((order) =>
      adjustOrderForCorporateActions(order, through)
    ),
    positions: args.positions.map((position) => ({
      ...position,
      ticker: currentStockTicker(position.ticker, position.currency),
    })),
  };
  args = withFreeStockPurchases(args);
  const giftOrders = new Map<string, IntegrationOrder>();
  for (const order of [...(args.benchmarkSource?.orders ?? []), ...args.orders]) if (isGiftReceipt(order)) {
    const adjusted = adjustOrderForCorporateActions(order, through);
    giftOrders.set(getOrderTransactionKey(adjusted), adjusted);
  }
  const giftReceipts = [...giftOrders.values()];
  const giftInstruments = new Set(giftReceipts.map(instrumentKey));
  const selected = selectedChartOrders(args);
  if (!selected.length && !args.accountPerformances?.some(account => account.fundingHistory?.length || account.cashHistory?.length)) {
    if (args.positions.length) throw new HistoryMismatchError(
      "Holdings exist but purchase history is empty after refresh. Ask admin to check the import.",
      "No purchase history for held instruments");
    throw new Error(
      "No purchase history for this chart. Complete broker order history is required.",
    );
  }
  const sources = new Map<
    string,
    IntegrationOrder | IntegrationPortfolioPosition
  >();
  for (const p of [...selected, ...args.positions, ...giftReceipts]) {
    const key = instrumentKey(p), previous = sources.get(key);
    sources.set(key, {
      ...previous,
      ...p,
      assetCategory: p.assetCategory ?? previous?.assetCategory ?? null,
      yahooSymbol: p.yahooSymbol ?? previous?.yahooSymbol,
      isin: p.isin ?? previous?.isin,
    });
  }
  const relevant = [...args.orders, ...giftReceipts.filter(gift => !args.orders.some(order => getOrderTransactionKey(order) === getOrderTransactionKey(gift)))].filter(isDisplayableOrder).filter((o) =>
    sources.has(instrumentKey(o))
  );
  for (const [key, source] of sources) {
    if (!relevant.some((o) => instrumentKey(o) === key && o.quantity > 0)) {
      throw new HistoryMismatchError(`${source.ticker}: no recorded purchases after refresh. Ask admin to check the import.`,
        `Purchase history is missing for ${source.ticker}.`);
    }
  }
  const histories = new Map<string, PriceHistory>();
  const entries = [...sources];
  const failures: FailedHistory[] = [];
  const symbols = new Map<string, string>();
  const requestedSources = new Map<string, typeof entries[number][1]>();
  for (let i = 0; i < entries.length; i += 3) {
    const batch = entries.slice(i, i + 3);
    const results = await Promise.allSettled(
      batch.map(async ([key, source]) => {
        const firstPurchase = relevant.filter((o) =>
          instrumentKey(o) === key && o.quantity > 0
        ).map((o) => dateOf(o.date)).sort()[0];
        if (isCfdAllocation(source)) {
          // CFD allocation marks come from funding cost, not a market ticker.
          histories.set(key, {
            symbol: "CFD",
            currency: source.currency,
            bars: [],
            splits: [],
          });
          return;
        }
        const instrumentOrders = relevant.filter((o) =>
          instrumentKey(o) === key
        );
        const held = giftInstruments.has(key) || args.positions.some((p) =>
          instrumentKey(p) === key && p.amount !== 0
        );
        const end = held ? undefined : dayAfter(
          instrumentOrders.map((o) => dateOf(o.date)).sort().at(-1)!,
        );
        const segments = optionHistorySegments(
          source.ticker,
          source.currency,
          dayAfter(firstPurchase, -7),
          end ?? dayAfter(through),
          through,
        ).filter((segment) => segment.end > firstPurchase);
        let history: PriceHistory | undefined;
        const missing: { start: string; end: string }[] = [];
        for (const segment of segments) {
          const segmentSource = { ...source, ticker: segment.ticker };
          try {
          requestedSources.set(key, segmentSource);
          symbols.delete(key);
          // Broker hints describe the current contract, not its predecessor.
          if (segment.ticker !== source.ticker) {
            delete segmentSource.yahooSymbol;
          }
          const symbol = await cache.resolve(
            segmentSource,
            segment.start <= firstPurchase ? firstPurchase : undefined,
            segment.end,
            true,
          );
          symbols.set(key, symbol);
          const part = await cache.get(symbol, segment.start, segment.end);
          const bars = part.bars.filter((bar) =>
            bar.date >= segment.start && bar.date < segment.end
          ).map((bar) => ({ ...bar, close: bar.close * segment.priceFactor }));
          if (!bars.length) {
            throw new Error("No historical closing prices returned.");
          }
          if (history && history.currency !== part.currency) {
            throw new Error("Historical contract currencies do not match.");
          }
          history = history
            ? { ...history, bars: [...history.bars, ...bars] }
            : {
              ...part,
              bars,
            };
          } catch (cause) {
            missing.push({ start: segment.start, end: segment.end });
            failures.push({ ticker: segmentSource.ticker, symbol: symbols.get(key) ?? segmentSource.ticker, cause });
          }
        }
        if (history) histories.set(key, missing.length ? { ...history, missing } : history);
      }),
    );
    for (const [index, result] of results.entries()) {
      if (result.status === "rejected") {
        const source = requestedSources.get(batch[index][0]) ?? batch[index][1];
        console.error(
          `Chart history failed for ${source.ticker} (${source.currency}):`,
          result.reason,
        );
        const symbol = (result.reason instanceof VontobelHistoryError
          ? VONTOBEL_PREFIX + result.reason.isin
          : result.reason instanceof MorganStanleyHistoryError
          ? MORGAN_STANLEY_PREFIX + result.reason.isin
          : undefined) ?? symbols.get(batch[index][0]) ??
          readYahooMapping(db, source.ticker) ??
          defaultYahooSymbols(source)[0] ?? source.ticker;
        failures.push({
          ticker: source.ticker,
          symbol: symbol.startsWith(DATABENTO_PREFIX)
            ? symbol.slice(DATABENTO_PREFIX.length)
            : symbol,
          cause: result.reason,
        });
      }
    }
  }
  if (failures.length) {
    for (const failure of failures) notes.push(`${failure.ticker}: ${failure.cause ? userErrorMessage(failure.cause) : "price history missing"} Affected dates are gaps.`);
  }
  const benchmarkAccounts = args.benchmarkSource?.accountPerformances ?? args.accountPerformances ?? [];
  // This is a benchmark assumption, never a persisted broker deposit. Once a
  // statement covers the purchase date, its real funding replaces the estimate.
  const provisionalOrders = kind === "perf"
    ? (args.benchmarkSource?.orders ?? selected).filter(order =>
      order.integrationKind === "ibkr" && isDisplayableOrder(order) &&
      order.quantity > 0 && !isGiftReceipt(order) && dateOf(order.date) === through &&
      benchmarkAccounts.some(account => account.integrationId === order.integrationId &&
        !account.pendingCashAdjustment && dateOf(account.historyThrough) < through))
    : [];
  const currencies = [...sources.values()].flatMap(portfolioPositionCurrencies).concat(
      [...histories.values()].map((h) => h.currency),
      (args.accountPerformances ?? []).flatMap(a => [a.currency, ...(a.reportedComponents?.map(c => c.currency) ?? [])]),
      (args.accountPerformances ?? []).flatMap(a => a.cashHistory?.map(event => event.currency) ?? []),
      args.orders.flatMap(order => [order.currency, ...(order.commission ? [order.commission.currency] : []),
        ...(!isDisplayableOrder(order) ? order.ticker.split(/[./]/).filter(code => /^[A-Z]{3}$/.test(code)) : [])]),
      benchmarkAccounts.map(account => account.currency),
      benchmarkAccounts.flatMap(account => nativeFundingFlows(account).map(flow => flow.nativeCurrency)),
      provisionalOrders.flatMap(order => [order.currency, ...(order.commission ? [order.commission.currency] : [])]),
    );
  const historyStart = [...selected.map(order => dateOf(order.date)),
    ...(args.accountPerformances ?? []).flatMap(account => [
      ...(account.fundingHistory?.map(flow => flow.date) ?? []),
      ...(account.cashHistory?.map(flow => flow.date) ?? []),
    ]), ...benchmarkAccounts.flatMap(account => account.fundingHistory?.map(flow => flow.date) ?? [])].sort()[0];
  let forceIgnoreFx = (args.accountPerformances ?? []).some(account => !!account.fxUnavailableReason) ||
    kind === "alltime" && !!args.benchmarkSource?.unavailableReason;
  if (!forceIgnoreFx) try { accountFxInputs(args.accountPerformances ?? [], args.orders.filter(order => !isDisplayableOrder(order))); }
  catch (error) { forceIgnoreFx = true; notes.push(`Currency P/L excluded: ${userErrorMessage(error)}`); }
  const fx = await loadChartFx(db, currencies, historyStart, through, request, forceIgnoreFx);
  const { rates, historical: historicalRates } = fx;
  notes.push(...fx.notes);
  const ignoreFx = fx.ignoreFx;
  notes.push(...(args.accountPerformances ?? []).flatMap(account => account.fxUnavailableReason ? [account.fxUnavailableReason] : []));
  const fingerprint = await hash({
    version: 16,
    args: {
      ...args,
      transactionBuckets: [...args.transactionBuckets],
      now: dateOf(args.now ?? new Date()),
    },
    histories: [...histories].sort(([a], [b]) => a.localeCompare(b)),
    rates: [...rates].sort(([a], [b]) => a.localeCompare(b)),
    historicalRates: [...historicalRates],
  });
  const stored = db.prepare(
    "SELECT payload FROM alltime_series_cache WHERE cache_key = ?",
  ).get(fingerprint) as { payload: string } | undefined;
  const cached = stored ? JSON.parse(stored.payload) as { points: AllTimePoint[]; notes: string[] } : undefined;
  const points = cached?.points ?? buildHistoricalReportSeries({ ...args, ignoreFx, notes }, histories, rates, historicalRates, kind);
  if (cached) notes.push(...cached.notes);
  try {
    const snapshot = await buildReportSnapshot({ ...reportArgs, positions: args.positions, currency: "USD", request: fx.request, ignoreFx }, kind);
    points[points.length - 1] = { ...points.at(-1)!, gain: snapshot.value, percentage: snapshot.percentage };
  } catch (error) {
    if (!(error instanceof Error) || !/Cannot build report: .*unavailable|incomplete valuation|Currency conversion unavailable|Could not load USD exchange rate|chart_rate/.test(error.message) &&
      !(error instanceof UserFacingError && error.code === "chart_rate")) throw error;
    notes.push("Live valuation missing; chart uses the last available close. Retry later.");
  }
  if (!stored) {
    db.prepare(
      "INSERT OR REPLACE INTO alltime_series_cache(cache_key,payload,created_at) VALUES (?,?,?)",
    ).run(fingerprint, JSON.stringify({ points, notes }), Date.now());
    db.exec(
      "DELETE FROM alltime_series_cache WHERE cache_key IN (SELECT cache_key FROM alltime_series_cache ORDER BY created_at DESC LIMIT -1 OFFSET 128)",
    );
  }
  const accounts = ignoreFx ? benchmarkAccounts.map(account => ({ ...account, cashHistory: undefined })) : benchmarkAccounts;
  if (giftReceipts.some(order => order.transactionKey?.includes('"free-stock"'))) {
    notes.push("Award dates missing; shares start today. Enable Grant Activity in Flex.");
  }
  let funding: ReturnType<typeof accountFunding>;
  try { funding = accountFunding(accounts, new Set([...args.positions, ...selected].map(item => item.integrationId)), rates); }
  catch (error) {
    if (!(error instanceof Error) || !/Currency conversion unavailable/.test(error.message)) throw error;
    funding = { deposits: 0, contributedCapital: null, complete: false, reason: "Funding conversion is missing." };
  }
  const purchases: BenchmarkPurchase[] = [];
  const datedFunding = !args.benchmarkSource?.unavailableReason && !funding.reason && accounts.every(account => {
    if (!account.fundingHistory) return false;
    let deposits = 0, withdrawals = 0;
    for (const flow of account.fundingHistory) {
      const timestamp = Date.parse(flow.date);
      const validDate = /^\d{4}-\d{2}-\d{2}$/.test(flow.date) && Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === flow.date;
      if (!validDate || !Number.isFinite(flow.amount) || flow.date > through) {
        const problem = !validDate ? `Funding date “${flow.date}” is not a calendar date`
          : flow.date > through ? `Funding date ${flow.date} is after chart date ${through}`
          : `Funding amount on ${flow.date} is ${flow.amount}`;
        throw new UserFacingError(`${problem}. Ask admin to check the import.`,
          { detail: "Invalid dated account funding" });
      }
      if (flow.allocation || flow.amount > 0) deposits += flow.amount;
      else withdrawals -= flow.amount;
      purchases.push({ date: flow.date, amountUsd: flow.amount * usdFactor(account.currency, rates), ...(flow.allocation ? { allocation: true } : {}) });
    }
    if (Math.abs(deposits - account.deposits) > .02 || Math.abs(withdrawals - account.withdrawals) > .02) {
      throw new UserFacingError(`Funding entries total ${deposits.toFixed(2)}/${withdrawals.toFixed(2)}; account totals ${account.deposits.toFixed(2)}/${account.withdrawals.toFixed(2)}. Ask admin to check the import.`,
        { detail: "Dated account funding does not reconcile with lifetime deposits and withdrawals" });
    }
    return true;
  });
  let benchmark: ChartBenchmark | undefined;
  let benchmarkInputsReady = false;
  let benchmarkGifts: ChartGiftPoint[] = [];
  let benchmarkFundingBasis: FundingBasisPoint[] = [];
  const benchmarkValuations: BenchmarkValuations = {};
  if (datedFunding) {
    try {
      const nativeFlows = accounts.flatMap(account => nativeFundingFlows(account).map(flow => ({ account, flow })));
      const foreignCurrencies = [...new Set(nativeFlows.filter(({ flow }) => !flow.allocation && flow.amount !== 0)
        .flatMap(({ account, flow }) => [account.currency, flow.nativeCurrency]))].filter(currency => currency !== "USD");
      const fundingRates = historicalRates;
      for (const currency of foreignCurrencies) {
        benchmarkValuations[currency] = fundingRates.get(currency)!.map(row => ({
          date: row.date, factor: usdFactor(currency, rates) / row.factor,
        }));
      }
      purchases.length = 0;
      for (const { account, flow } of nativeFlows) {
        const contributionUsd = flow.amount * usdFactor(account.currency, rates);
        const amountUsd = flow.allocation || flow.amount === 0 ? contributionUsd
          : flow.nativeAmount * historicalUsdFactor(fundingRates, flow.nativeCurrency, flow.date);
        purchases.push({ date: flow.date, amountUsd,
          ...(account.currency !== "USD" && !flow.allocation ? { contributionUsd } : {}),
          ...(account.currency !== "USD" ? { valuationCurrency: account.currency } : {}),
          ...(flow.allocation ? { allocation: true } : {}),
        });
      }
      for (const order of provisionalOrders) {
        const account = accounts.find(account => account.integrationId === order.integrationId)!;
        const amountUsd = -executionCash(order).reduce((sum, movement) =>
          sum + movement.amount * historicalUsdFactor(historicalRates, movement.currency, through), 0);
        if (!Number.isFinite(amountUsd) || amountUsd <= 0) throw new UserFacingError(
          `${order.ticker}: estimated funding is ${amountUsd} USD. Ask admin to check the cash calculation.`,
          { detail: `Invalid provisional purchase cost for ${order.ticker}` });
        purchases.push({ date: through, amountUsd,
          ...(account.currency !== "USD" ? {
            contributionUsd: amountUsd * usdFactor(account.currency, rates) / historicalUsdFactor(historicalRates, account.currency, through),
            valuationCurrency: account.currency,
          } : {}),
        });
      }
      benchmarkGifts = buildChartGifts(giftReceipts, histories, historicalRates,
        args.benchmarkSource?.positions ?? args.positions, rates, points[0].date, points.at(-1)!.date);
      for (let date = points[0].date; date <= points.at(-1)!.date; date = dayAfter(date)) {
        const dated = datedFxAccounts(accounts, date);
        const topups = accountTopups(dated);
        const basisCurrencies = [...new Set(dated.flatMap(account => [account.currency, ...nativeFundingFlows(account).map(flow => flow.nativeCurrency)]))];
        const dayRates = new Map(basisCurrencies.map(currency => [currency, historicalUsdFactor(historicalRates, currency, date)]));
        const capital = accountFunding(dated, new Set(dated.map(account => account.integrationId)), dayRates).contributedCapital;
        benchmarkFundingBasis.push({ date,
          contributedCapital: capital ?? 0,
          deposits: topups.reduce((sum, topup) => sum + topup.deposits * historicalUsdFactor(historicalRates, topup.currency, date), 0),
          withdrawals: topups.reduce((sum, topup) => sum + topup.withdrawals * historicalUsdFactor(historicalRates, topup.currency, date), 0) });
      }
      benchmarkInputsReady = true;
      benchmark = await loadChartBenchmark(purchases, points[0].date, points.at(-1)!.date, cache, "sp500", benchmarkValuations);
      benchmark = withChartGifts(benchmark, benchmarkGifts);
      benchmark = benchmarkForKind(benchmarkWithFundingBasis(benchmark, benchmarkFundingBasis), kind);
    } catch (error) {
      benchmark = undefined;
      console.error(`Index construction failed (${fingerprint.slice(0, 8)}):`, error);
      notes.push(`Index hidden: ${userErrorMessage(error, fingerprint.slice(0, 8))}`);
    }
  } else notes.push(`Index hidden: ${args.benchmarkSource?.unavailableReason ?? (funding.reason
    ? userErrorMessage(new Error(funding.reason))
    : "Deposit dates are missing. Wait for funding sync, then retry.")}`);
  const purchaseDates = [...new Set(selected.filter(order => !isGiftReceipt(order)).map(order => dateOf(order.date)))].sort();
  return { fundingReturnVersion: 6, kind: args.kind, filter: args.filter, userId, label, bucketName: args.bucketName, points, purchaseDates, notes: [...new Set(notes)], benchmarkIndex: "sp500", ...(benchmark ? { benchmark } : {}), ...(benchmarkInputsReady ? { benchmarkInputsReady, benchmarkPurchases: purchases, benchmarkValuations, benchmarkFundingBasis, ...(benchmarkGifts.length ? { benchmarkGifts } : {}) } : {}) };
}

export const hasChartBenchmarkInputs = (dataset: AllTimeDataset) =>
  !!dataset.benchmarkPurchases && (!!dataset.benchmark || dataset.benchmarkInputsReady === true);

export const selectedChartBenchmark = (datasets: AllTimeDataset[]) => datasets[0]?.benchmarkIndex ??
  chartBenchmarkIndex(datasets.find(dataset => dataset.benchmark)?.benchmark?.symbol);

export async function switchChartBenchmarks(
  db: Database,
  datasets: AllTimeDataset[],
  index: ChartBenchmarkIndex,
  cache: Parameters<typeof loadChartBenchmark>[3] = historyCache(db),
): Promise<AllTimeDataset[]> {
  if (datasets.some(dataset => dataset.fundingReturnVersion !== 6)) {
    throw new UserFacingError("Saved chart uses the old contribution rule. Run /chart again.",
      { detail: "This chart uses an older return calculation. Create a new chart with /chart." });
  }
  const missing = datasets.find(dataset => !hasChartBenchmarkInputs(dataset));
  if (!datasets.some(hasChartBenchmarkInputs)) throw new UserFacingError(missing?.notes?.find(note => note.startsWith("Index hidden:")) ??
    "Saved index details are missing. Run /chart again.");
  const results = await Promise.allSettled(datasets.map(async (dataset) => {
    if (!hasChartBenchmarkInputs(dataset)) return { ...dataset, benchmarkIndex: index, benchmark: undefined };
    const current = chartBenchmarkIndex(dataset.benchmark?.symbol);
    if (dataset.benchmark && current === index) return { ...dataset, benchmarkIndex: index };
    let benchmark = dataset.benchmarkSnapshots?.[index] ?? await loadChartBenchmark(
      dataset.benchmarkPurchases!, dataset.points[0].date,
      dataset.points.at(-1)!.date, cache, index, dataset.benchmarkValuations,
    );
    if (!dataset.benchmarkSnapshots?.[index]) benchmark = benchmarkForKind(benchmarkWithFundingBasis(withChartGifts(benchmark, dataset.benchmarkGifts ?? []), dataset.benchmarkFundingBasis), dataset.kind ?? "alltime");
    return {
      ...dataset, benchmarkIndex: index, benchmark,
      ...(dataset.notes ? { notes: dataset.notes.filter(note => !note.startsWith("Index hidden:")) } : {}),
      benchmarkSnapshots: { ...dataset.benchmarkSnapshots, ...(dataset.benchmark ? { [current]: dataset.benchmark } : {}), [index]: benchmark },
    };
  }));
  const failure = results.find(result => result.status === "rejected");
  // Keep the current chart when no requested index could be built at all.
  if (failure?.status === "rejected" && !results.some(result => result.status === "fulfilled" && !!result.value.benchmark)) throw failure.reason;
  return results.map((result, i) => {
    if (result.status === "fulfilled") return result.value;
    const dataset = datasets[i];
    console.error(`Index switch failed for ${dataset.label}:`, result.reason);
    return { ...dataset, benchmarkIndex: index, benchmarkInputsReady: true, benchmark: undefined,
      benchmarkSnapshots: { ...dataset.benchmarkSnapshots, ...(dataset.benchmark ? { [chartBenchmarkIndex(dataset.benchmark.symbol)]: dataset.benchmark } : {}) },
      notes: [...(dataset.notes ?? []).filter(note => !note.startsWith("Index hidden:")), `Index hidden: ${userErrorMessage(result.reason)}`] };
  });
}

export async function renderAllTimeChart(
  db: Database,
  datasets: AllTimeDataset[],
): Promise<Uint8Array> {
  ensureChartSchema(db);
  if (!datasets.length || datasets.some((dataset) => dataset.fundingReturnVersion !== 6)) {
    throw new UserFacingError("Saved chart uses the old contribution rule. Run /chart again.",
      { detail: "This chart uses an older return calculation. Create a new chart with /chart." });
  }
  const key = await hash({ version: 23, datasets });
  const stored = db.prepare(
    "SELECT png FROM alltime_render_cache WHERE cache_key = ?",
  ).get(key) as { png: Uint8Array } | undefined;
  if (stored) return stored.png;
  const png = renderAllTimeDatasets(datasets);
  db.prepare(
    "INSERT OR REPLACE INTO alltime_render_cache(cache_key,png,created_at) VALUES (?,?,?)",
  ).run(key, png, Date.now());
  db.exec(
    "DELETE FROM alltime_render_cache WHERE cache_key IN (SELECT cache_key FROM alltime_render_cache ORDER BY created_at DESC LIMIT -1 OFFSET 128)",
  );
  return png;
}
