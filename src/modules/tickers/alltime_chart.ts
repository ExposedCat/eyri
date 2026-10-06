import type { Database } from "../database/setup.ts";
import type {
  IntegrationOrder,
  IntegrationPortfolioPosition,
} from "../integrations/types.ts";
import { usdFactor } from "../integrations/usd.ts";
import { fetchUsdConversionRates } from "../../utils/exchange_rates.ts";
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
};
type Args = {
  positions: IntegrationPortfolioPosition[];
  orders: IntegrationOrder[];
  transactionBuckets: Map<string, string>;
  bucketName: string | null;
  now?: Date;
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
  };
  const lots = new Map<string, Lot[]>();
  const prices = new Map<string, number>();
  const barIndices = new Map<string, number>();
  const splitIndices = new Map<string, number>();
  let orderIndex = 0, realized = 0, realizedCost = 0;
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
        });
      } else {
        let remaining = -order.quantity;
        while (remaining > EPSILON && accountLots.length) {
          const lot = accountLots[0];
          const quantity = Math.min(remaining, lot.quantity);
          if (lot.selected) {
            const factor = usdFactor(lot.currency, rates);
            realized += quantity * (order.price - lot.price) * factor;
            realizedCost += quantity * lot.price * factor;
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
    let cost = realizedCost, gain = realized;
    for (const accountLots of lots.values()) {
      for (const lot of accountLots) {
        if (!lot.selected || lot.quantity < EPSILON) continue;
        const close = prices.get(lot.key), history = histories.get(lot.key);
        if (close === undefined || !history) {
          throw new Error(
            `Historical closing price unavailable on ${date} for ${
              JSON.parse(lot.key)[0]
            }.`,
          );
        }
        const basis = lot.quantity * lot.price * usdFactor(lot.currency, rates);
        cost += basis;
        gain += lot.quantity * close * usdFactor(history.currency, rates) -
          basis;
      }
    }
    points.push({ date, percentage: cost === 0 ? 0 : gain / cost * 100, gain });
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
        `History does not reconcile with live ${
          JSON.parse(key)[0]
        } holdings. Check transfers, ticker changes and missing trades.`,
      );
    }
  }
  // Use exactly /alltime's current + FIFO-sold cost/P&L for the live endpoint.
  let cost = 0, gain = 0;
  for (const p of args.positions) {
    if (
      p.currentPrice === null || p.totalInput === null ||
      p.averageUnitPrice === null
    ) {
      throw new Error(
        `Current price or book cost unavailable for ${p.ticker}.`,
      );
    }
    const factor = usdFactor(p.currency, rates);
    cost += p.totalInput * factor;
    gain += (p.currentPrice * p.amount - p.totalInput) * factor;
  }
  const hasSplits = [...histories.values()].some((h) => h.splits.length);
  // Native FIFO already has /alltime's semantics. Split-aware reconstruction is
  // needed when historical fills use pre-split units; its realized values are canonical then.
  if (hasSplits) {
    cost += realizedCost;
    gain += realized;
  } else {
    for (
      const p of buildIntegratedSoldPerformances(
        args.orders,
        args.transactionBuckets,
        args.bucketName,
      )
    ) {
      const factor = usdFactor(p.currency, rates);
      cost += p.cost * factor;
      gain += p.realizedPnl * factor;
    }
  }
  points[points.length - 1] = {
    date: last,
    percentage: cost === 0 ? 0 : gain / cost * 100,
    gain,
  };
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
  const start = dayAfter(relevant.map((o) => dateOf(o.date)).sort()[0], -7);
  const histories = new Map<string, PriceHistory>();
  const entries = [...sources];
  const failures: string[] = [];
  for (let i = 0; i < entries.length; i += 3) {
    const batch = entries.slice(i, i + 3);
    const results = await Promise.allSettled(
      batch.map(async ([key, source]) => {
        const firstPurchase = relevant.filter((o) =>
          instrumentKey(o) === key && o.quantity > 0
        ).map((o) => dateOf(o.date)).sort()[0];
        const symbol = await cache.resolve(source, firstPurchase);
        const history = await cache.get(symbol, start);
        if (!history.bars.length) {
          throw new Error("No historical closing prices returned.");
        }
        histories.set(key, history);
      }),
    );
    for (const [index, result] of results.entries()) {
      if (result.status === "rejected") {
        const source = batch[index][1];
        const reason = result.reason instanceof Error
          ? result.reason.message
          : String(result.reason);
        failures.push(`${source.ticker} (${source.currency}): ${reason}`);
      }
    }
  }
  if (failures.length) {
    throw new Error(
      `Could not build chart. Historical prices failed for:\n${
        failures.join("\n")
      }`.slice(0, 3500),
    );
  }
  const rates = await fetchUsdConversionRates(
    [...sources.values()].map((p) => p.currency).concat(
      [...histories.values()].map((h) => h.currency),
    ),
    request,
  );
  const fingerprint = await hash({
    version: 1,
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
  const key = await hash({ version: 1, datasets });
  const stored = db.prepare(
    "SELECT png FROM alltime_render_cache WHERE cache_key = ?",
  ).get(key) as { png: Uint8Array } | undefined;
  if (stored) return stored.png;
  const process = new Deno.Command("python3", {
    args: [
      decodeURIComponent(
        new URL("./alltime_chart.py", import.meta.url).pathname,
      ),
    ],
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
    signal: AbortSignal.timeout(30_000),
  }).spawn();
  const output = process.output();
  const writer = process.stdin.getWriter();
  await writer.write(new TextEncoder().encode(JSON.stringify(datasets)));
  await writer.close();
  const result = await output;
  if (!result.success) {
    console.error(new TextDecoder().decode(result.stderr));
    throw new Error("Could not render the all-time chart.");
  }
  db.prepare(
    "INSERT OR REPLACE INTO alltime_render_cache(cache_key,png,created_at) VALUES (?,?,?)",
  ).run(key, result.stdout, Date.now());
  db.exec(
    "DELETE FROM alltime_render_cache WHERE cache_key IN (SELECT cache_key FROM alltime_render_cache ORDER BY created_at DESC LIMIT -1 OFFSET 128)",
  );
  return result.stdout;
}
