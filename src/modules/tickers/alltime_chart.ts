import type { Database } from "../database/setup.ts";
import { renderAllTimeDatasets } from "./alltime_chart_renderer.ts";
import { historicalQuoteMultiplier } from "../market_data/options.ts";
import { DATABENTO_PREFIX } from "../market_data/databento.ts";
import { VONTOBEL_PREFIX, VontobelHistoryError } from "../market_data/vontobel.ts";
import {
  type FailedHistory,
  HistoricalDataError,
} from "../market_data/errors.ts";
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
import { fetchUsdConversionRates } from "../../utils/exchange_rates.ts";
import { portfolioPositionCurrencies, portfolioValuations } from "../integrations/usd.ts";
import { isCfdAllocation } from "./cfd_history.ts";
import {
  dayAfter,
  type PriceHistory,
  YahooHistoryCache,
} from "../market_data/yahoo.ts";
import {
  buildIntegratedSoldPerformances,
  getOrderTransactionKey,
  isDisplayableOrder,
} from "./portfolio.ts";

export type AllTimePoint = { date: string; percentage: number; gain: number };
export type AllTimeDataset = {
  userId: number;
  label: string;
  bucketName: string | null;
  points: AllTimePoint[];
  // Points remain USD snapshots; only single-chart monetary labels use these.
  displayCurrency?: string;
  displayRate?: number;
};
type Args = {
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
    order.account.trim().toUpperCase(),
    instrumentKey(order),
  ]);
const dateOf = (date: Date) => date.toISOString().slice(0, 10);

export function selectedChartOrders(args: Args) {
  return args.orders.filter((order) =>
    isDisplayableOrder(order) && order.quantity > 0 &&
    (args.transactionBuckets.get(getOrderTransactionKey(order)) ?? null) ===
      args.bucketName
  );
}

export function buildAllTimeSeries(
  args: Args,
  histories: Map<string, PriceHistory>,
  rates: ReadonlyMap<string, number>,
): AllTimePoint[] {
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
  const pointInUsd = (date: string, totals: Map<string, Totals>): AllTimePoint => {
    let cost = 0, gain = 0;
    for (const [currency, native] of totals) {
      const factor = usdFactor(currency, rates);
      cost += native.cost * factor;
      gain += native.gain * factor;
    }
    return { date, percentage: cost === 0 ? 0 : gain / cost * 100, gain };
  };
  const realized = new Map<string, Totals>();
  const nativeWalletRealized = new Map<string, Totals>();
  let orderIndex = 0;
  const points: AllTimePoint[] = [{
    date: dayAfter(first, -1),
    percentage: 0,
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
          price: order.price,
          selected:
            (args.transactionBuckets.get(getOrderTransactionKey(order)) ??
              null) === args.bucketName,
          currency: order.currency,
          atCost: isCfdAllocation(order),
          quoteMultiplier: historicalQuoteMultiplier(
            args.positions.find((p) =>
              p.integrationId === order.integrationId &&
              p.account === order.account && instrumentKey(p) === key
            ) ?? order,
          ),
        });
      } else {
        let remaining = -order.quantity;
        while (remaining > EPSILON && accountLots.length) {
          const lot = accountLots[0];
          const quantity = Math.min(remaining, lot.quantity);
          if (lot.selected) {
            addTotals(
              realized,
              lot.currency,
              quantity * lot.price,
              quantity * (order.price - lot.price),
            );
            if (order.walletImpact) addTotals(nativeWalletRealized, lot.currency,
              quantity * lot.price, quantity * (order.price - lot.price));
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
  for (const account of args.accountPerformances ?? []) {
    if (!account.reportedComponents) throw new Error("Account reconciliation snapshot is missing");
    for (const c of account.reportedComponents) addTotals(totals, c.currency, -c.cost, -c.pnl);
    addTotals(totals, account.currency, account.netContributions, account.pnl);
  }
  points[points.length - 1] = pointInUsd(last, totals);
  return points;
}

const caches = new WeakMap<Database, YahooHistoryCache>();
export function historyCache(db: Database) {
  let cache = caches.get(db);
  if (!cache) {
    cache = new YahooHistoryCache(db);
    caches.set(db, cache);
  }
  return cache;
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
  const selected = selectedChartOrders(args);
  if (!selected.length) {
    throw new Error(
      "No purchase history for this chart. Complete broker order history is required.",
    );
  }
  const sources = new Map<
    string,
    IntegrationOrder | IntegrationPortfolioPosition
  >();
  for (const p of [...selected, ...args.positions]) {
    const key = instrumentKey(p), previous = sources.get(key);
    sources.set(key, {
      ...p,
      yahooSymbol: p.yahooSymbol ?? previous?.yahooSymbol,
      isin: p.isin ?? previous?.isin,
    });
  }
  const relevant = args.orders.filter(isDisplayableOrder).filter((o) =>
    sources.has(instrumentKey(o))
  );
  for (const [key, source] of sources) {
    if (!relevant.some((o) => instrumentKey(o) === key && o.quantity > 0)) {
      throw new Error(
        `Purchase history is missing for ${source.ticker}. Check transfers and corporate actions.`,
      );
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
        const held = args.positions.some((p) =>
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
        for (const segment of segments) {
          const segmentSource = { ...source, ticker: segment.ticker };
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
        }
        if (!history) throw new Error("No historical closing prices returned.");
        histories.set(key, history);
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
          : undefined) ?? symbols.get(batch[index][0]) ??
          readYahooMapping(db, source.ticker) ??
          defaultYahooSymbols(source)[0] ?? source.ticker;
        failures.push({
          ticker: source.ticker,
          symbol: symbol.startsWith(DATABENTO_PREFIX)
            ? symbol.slice(DATABENTO_PREFIX.length)
            : symbol,
        });
      }
    }
  }
  if (failures.length) {
    throw new HistoricalDataError(failures);
  }
  const rates = await fetchUsdConversionRates(
    [...sources.values()].flatMap(portfolioPositionCurrencies).concat(
      [...histories.values()].map((h) => h.currency),
      (args.accountPerformances ?? []).flatMap(a => [a.currency, ...(a.reportedComponents?.map(c => c.currency) ?? [])]),
    ),
    request,
  );
  const fingerprint = await hash({
    version: 3,
    args: {
      ...args,
      transactionBuckets: [...args.transactionBuckets],
      now: dateOf(args.now ?? new Date()),
    },
    histories: [...histories].sort(([a], [b]) => a.localeCompare(b)),
    rates: [...rates].sort(([a], [b]) => a.localeCompare(b)),
  });
  const stored = db.prepare(
    "SELECT payload FROM alltime_series_cache WHERE cache_key = ?",
  ).get(fingerprint) as { payload: string } | undefined;
  const points = stored
    ? JSON.parse(stored.payload)
    : buildAllTimeSeries(args, histories, rates);
  if (!stored) {
    db.prepare(
      "INSERT OR REPLACE INTO alltime_series_cache(cache_key,payload,created_at) VALUES (?,?,?)",
    ).run(fingerprint, JSON.stringify(points), Date.now());
    db.exec(
      "DELETE FROM alltime_series_cache WHERE cache_key IN (SELECT cache_key FROM alltime_series_cache ORDER BY created_at DESC LIMIT -1 OFFSET 128)",
    );
  }
  return { userId, label, bucketName: args.bucketName, points };
}

export async function renderAllTimeChart(
  db: Database,
  datasets: AllTimeDataset[],
): Promise<Uint8Array> {
  ensureChartSchema(db);
  const key = await hash({ version: 5, datasets });
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
