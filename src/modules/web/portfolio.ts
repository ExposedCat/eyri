import { fetchConversionRates } from "../../utils/exchange_rates.ts";
import { getUserBucket, getUserBuckets } from "../database/bucket.ts";
import { getUserIntegrations } from "../database/integration.ts";
import type { Database } from "../database/setup.ts";
import { readUser } from "../database/user.ts";
import { describeIntegration } from "../integrations/description.ts";
import { fetchIntegratedIbkrStockQuotes } from "../integrations/ibkr/quotes.ts";
import { conversionFactor } from "../integrations/usd.ts";
import { defaultYahooSymbols } from "../market_data/symbols.ts";
import { readYahooMapping } from "../market_data/mappings.ts";
import { yahooOptionContract } from "../market_data/options.ts";
import {
  type AllTimeDataset,
  loadAllTimeDataset,
  switchChartBenchmarks,
} from "../tickers/alltime_chart.ts";
import { type ChartBenchmarkIndex } from "../tickers/chart_benchmark.ts";
import {
  isOptionPosition,
  isStockPosition,
} from "../tickers/portfolio.ts";
import {
  fetchPortfolioView,
  hasPortfolioViewIntegrations,
} from "../tickers/portfolio_view.ts";
import type { ReportFilter } from "../tickers/performance_command.ts";
import { type ReportRuntime, runReport } from "../mcp/reports.ts";
import { ensureWebSchema } from "./auth.ts";
import { sanitizeSymbol } from "./market.ts";

export type WatchlistItem = {
  symbol: string;
  addedAt: number;
};

export type WebPersonalChartKind = "alltime" | "perf" | "worth";
export type WebBenchmarkOption = "none" | ChartBenchmarkIndex;

export type PersonalChartPoint = {
  date: string;
  value: number | null;
  returnPct: number | null;
  benchmarkValue: number | null;
  benchmarkReturnPct: number | null;
};

export type PersonalChartKeyPoints = {
  peakValue: { date: string; value: number } | null;
  troughValue: { date: string; value: number } | null;
  peakReturn: { date: string; value: number } | null;
  troughReturn: { date: string; value: number } | null;
  maxDrawdown: { pct: number; peakDate: string; troughDate: string } | null;
  bestDay: { date: string; delta: number } | null;
  worstDay: { date: string; delta: number } | null;
};

export type WebPersonalChartResponse = {
  currency: string;
  kind: WebPersonalChartKind;
  filter: ReportFilter | "all";
  bucketName: string | null;
  benchmark: WebBenchmarkOption;
  benchmarkLabel: string | null;
  hasBenchmark: boolean;
  notes: string[];
  purchaseDates: string[];
  points: PersonalChartPoint[];
  keyPoints: PersonalChartKeyPoints;
  cached?: boolean;
  refreshing?: boolean;
  updatedAt?: string;
};

export type UserTickerTrade = {
  date: string;
  side: "buy" | "sell";
  quantity: number;
  price: number | null;
  currency: string;
};

export type UserTickerContext = {
  symbol: string;
  currency: string;
  position: {
    ticker: string;
    amount: number;
    averagePrice: number | null;
    currentPrice: number | null;
    cost: number | null;
    value: number | null;
    pnl: number | null;
    returnPct: number | null;
    dailyPnl: number | null;
    dailyPct: number | null;
    period: string | null;
  } | null;
  trades: UserTickerTrade[];
};

type PortfolioViewValue = Awaited<ReturnType<typeof fetchPortfolioView>>;
type CacheBucket = {
  views: Map<string, { createdAt: number; expiresAt: number; promise: Promise<PortfolioViewValue> }>;
  datasets: Map<string, { createdAt: number; expiresAt: number; promise: Promise<AllTimeDataset> }>;
  fxResponses: Map<string, { expiresAt: number; status: number; body: string }>;
};

const VIEW_CACHE_TTL_MS = 60_000;
const DATASET_CACHE_TTL_MS = 120_000;
const PERSISTENT_CHART_FRESH_MS = 5 * 60_000;
const FX_CACHE_TTL_MS = 120_000;
const dbCaches = new WeakMap<Database, CacheBucket>();
const backgroundChartRefreshes = new WeakMap<Database, Map<string, Promise<void>>>();

function readPersistentChartCache(
  db: Database,
  cacheKey: string,
): { dataset: AllTimeDataset; updatedAt: string; ageMs: number } | null {
  ensureWebSchema(db);
  const row = db
    .prepare("SELECT dataset_json, updated_at FROM web_personal_chart_cache WHERE cache_key = ?")
    .get(cacheKey) as { dataset_json: string; updated_at: string } | undefined;
  if (!row) return null;
  try {
    const dataset = JSON.parse(row.dataset_json) as AllTimeDataset;
    if (!dataset || dataset.fundingReturnVersion !== 6 || !Array.isArray(dataset.points)) {
      return null;
    }
    const ts = Date.parse(row.updated_at);
    return {
      dataset,
      updatedAt: row.updated_at,
      ageMs: Number.isFinite(ts) ? Math.max(0, Date.now() - ts) : Infinity,
    };
  } catch {
    return null;
  }
}

function writePersistentChartCache(
  db: Database,
  cacheKey: string,
  userId: number,
  dataset: AllTimeDataset,
  nowMs = Date.now(),
): string {
  ensureWebSchema(db);
  const updatedAt = new Date(nowMs).toISOString();
  db.prepare(`
    INSERT OR REPLACE INTO web_personal_chart_cache (cache_key, user_id, dataset_json, updated_at)
    VALUES (?, ?, ?, ?)
  `).run(cacheKey, userId, JSON.stringify(dataset), updatedAt);
  return updatedAt;
}

// Reuse any matching Telegram /chart dataset already saved in SQLite so the first
// web visit renders instantly without waiting for a cold option/history replay.
function readTelegramSavedChartDataset(
  db: Database,
  userId: number,
  bucketName: string | null,
  kind: WebPersonalChartKind,
  filter: ReportFilter | undefined,
): AllTimeDataset | null {
  try {
    const hasTable = db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'alltime_chart_sessions'")
      .get();
    if (!hasTable) return null;
    const rows = db
      .prepare("SELECT datasets FROM alltime_chart_sessions ORDER BY rowid DESC LIMIT 25")
      .all() as { datasets: string }[];
    for (const row of rows) {
      let parsed: AllTimeDataset[];
      try {
        parsed = JSON.parse(row.datasets);
      } catch {
        continue;
      }
      if (!Array.isArray(parsed)) continue;
      const match = parsed.find((d) =>
        d &&
        d.fundingReturnVersion === 6 &&
        d.userId === userId &&
        (d.bucketName ?? null) === bucketName &&
        (d.kind ?? "alltime") === kind &&
        (d.filter ?? undefined) === filter &&
        Array.isArray(d.points) &&
        d.points.length > 0
      );
      if (match) return match;
    }
  } catch {
    // Ignore optional table read errors.
  }
  return null;
}

function getDbCache(db: Database): CacheBucket {
  let bucket = dbCaches.get(db);
  if (!bucket) {
    bucket = {
      views: new Map(),
      datasets: new Map(),
      fxResponses: new Map(),
    };
    dbCaches.set(db, bucket);
  }
  return bucket;
}

export function clearUserPortfolioCaches(db: Database, userId: number, now = Date.now()) {
  const cache = dbCaches.get(db);
  if (!cache) return;
  const prefix = `${userId}:`;
  for (const [key, entry] of cache.views) {
    if (key.startsWith(prefix) && now - entry.createdAt > 2_000) cache.views.delete(key);
  }
  for (const [key, entry] of cache.datasets) {
    if (key.startsWith(prefix) && now - entry.createdAt > 2_000) cache.datasets.delete(key);
  }
}

function createCachedFxFetch(db: Database, baseFetch: typeof fetch): typeof fetch {
  const cache = getDbCache(db).fxResponses;
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const urlStr = typeof input === "string"
      ? input
      : input instanceof URL
      ? input.toString()
      : input.url;
    const isFx = (!init?.method || init.method.toUpperCase() === "GET") &&
      urlStr.startsWith("https://api.frankfurter.dev/");
    if (!isFx) return baseFetch(input, init);
    const now = Date.now();
    const hit = cache.get(urlStr);
    if (hit && hit.expiresAt > now) {
      return new Response(hit.body, {
        status: hit.status,
        headers: { "Content-Type": "application/json" },
      });
    }
    const res = await baseFetch(input, init);
    if (res.ok) {
      const body = await res.text();
      cache.set(urlStr, { expiresAt: now + FX_CACHE_TTL_MS, status: res.status, body });
      return new Response(body, {
        status: res.status,
        headers: { "Content-Type": "application/json" },
      });
    }
    return res;
  }) as typeof fetch;
}

function getSharedPortfolioView(
  db: Database,
  userId: number,
  bucketName: string | null,
  loader: typeof fetchPortfolioView = fetchPortfolioView,
  forceRefresh = false,
): Promise<PortfolioViewValue> {
  // Custom test loaders bypass the shared cache unless using the default loader.
  if (loader !== fetchPortfolioView) {
    return loader(db, userId, bucketName, {
      positions: true,
      history: true,
      displayHistory: true,
      accountPerformance: true,
      warrantQuotes: true,
      dailyPnl: true,
    });
  }
  const cache = getDbCache(db).views;
  const key = `${userId}:${bucketName ?? ""}`;
  const now = Date.now();
  const existing = cache.get(key);
  if (existing && (existing.expiresAt > now && (!forceRefresh || now - existing.createdAt <= 2_000))) {
    return existing.promise;
  }
  const promise = loader(db, userId, bucketName, {
    positions: true,
    history: true,
    displayHistory: true,
    accountPerformance: true,
    warrantQuotes: true,
    dailyPnl: true,
  }).catch((error) => {
    if (cache.get(key)?.promise === promise) cache.delete(key);
    throw error;
  });
  cache.set(key, { createdAt: now, expiresAt: now + VIEW_CACHE_TTL_MS, promise });
  return promise;
}

export function listWatchlist(db: Database, userId: number): WatchlistItem[] {
  ensureWebSchema(db);
  const rows = db
    .prepare("SELECT symbol, added_at FROM web_watchlist WHERE user_id = ? ORDER BY added_at ASC")
    .all(userId) as { symbol: string; added_at: string }[];
  return rows.map((row) => ({ symbol: row.symbol, addedAt: Date.parse(row.added_at) || 0 }));
}

export function addWatchlistSymbol(
  db: Database,
  userId: number,
  rawSymbol: string,
  nowMs = Date.now(),
): WatchlistItem {
  ensureWebSchema(db);
  const symbol = sanitizeSymbol(rawSymbol);
  if (!symbol) throw new Error("Invalid ticker symbol.");
  const count = (db
    .prepare("SELECT COUNT(*) as count FROM web_watchlist WHERE user_id = ?")
    .get(userId) as { count: number }).count;
  const existing = db
    .prepare("SELECT symbol, added_at FROM web_watchlist WHERE user_id = ? AND symbol = ?")
    .get(userId, symbol) as { symbol: string; added_at: string } | undefined;
  if (existing) {
    return { symbol: existing.symbol, addedAt: Date.parse(existing.added_at) || nowMs };
  }
  if (count >= 40) {
    throw new Error("Watchlist limit reached (max 40 tickers).");
  }
  db.prepare("INSERT INTO web_watchlist (user_id, symbol, added_at) VALUES (?, ?, ?)")
    .run(userId, symbol, new Date(nowMs).toISOString());
  return { symbol, addedAt: nowMs };
}

export function removeWatchlistSymbol(db: Database, userId: number, rawSymbol: string): boolean {
  ensureWebSchema(db);
  const symbol = sanitizeSymbol(rawSymbol);
  if (!symbol) return false;
  const changes = db
    .prepare("DELETE FROM web_watchlist WHERE user_id = ? AND symbol = ?")
    .run(userId, symbol);
  return changes > 0;
}

function formatOptionDisplay(ticker: string): {
  displayTicker: string;
  optionMeta: { underlying: string; expiry: string; right: "C" | "P"; strike: number; occSymbol: string } | null;
} {
  const opt = yahooOptionContract(ticker);
  if (!opt) {
    // Strip broker suffixes like .US or _US_EQ for clean display
    const cleaned = ticker.trim().toUpperCase()
      .replace(/\.US$/, "")
      .replace(/_US_EQ$/, "");
    return { displayTicker: cleaned, optionMeta: null };
  }
  const occMatch = opt.symbol.match(/^[A-Z0-9]{1,6}\d{6}([CP])(\d{8})$/);
  const right = (occMatch?.[1] === "P" ? "P" : "C") as "C" | "P";
  const strike = occMatch ? Number(occMatch[2]) / 1000 : 0;
  const strikeText = Number.isInteger(strike) ? String(strike) : String(Number(strike.toFixed(2)));
  return {
    displayTicker: `${opt.underlying} $${strikeText}${right}`,
    optionMeta: {
      underlying: opt.underlying,
      expiry: opt.expiry,
      right,
      strike,
      occSymbol: opt.symbol,
    },
  };
}

function guessYahooSymbol(
  db: Database,
  ticker: string,
  nativeCurrency: string,
  hint?: { yahooSymbol?: string; exchange?: string },
): string {
  const mapped = readYahooMapping(db, ticker);
  if (mapped) return mapped;
  const opt = yahooOptionContract(ticker);
  if (opt) return opt.symbol;
  const candidates = defaultYahooSymbols({
    ticker,
    currency: nativeCurrency,
    yahooSymbol: hint?.yahooSymbol,
    exchange: hint?.exchange,
  });
  return candidates[0] ?? ticker.trim().toUpperCase().replace(/\.US$/, "");
}

export async function loadWebOverview(
  db: Database,
  userId: number,
  options: {
    bucketName?: string | null;
    filter?: ReportFilter;
    refresh?: boolean;
    runtime?: ReportRuntime;
  } = {},
) {
  const user = readUser(db, userId);
  if (!user) throw new Error("User not found.");
  const currency = user.currency ?? "USD";
  const bucketName = options.bucketName ?? null;
  const filter = options.filter;

  if (options.refresh) clearUserPortfolioCaches(db, userId);

  const buckets = getUserBuckets(db, userId).map((bucket) => ({
    name: bucket.name,
    ownerUserId: bucket.ownerUserId,
    share: bucket.share,
    included: bucket.included,
  }));
  const integrations = getUserIntegrations(db, userId).map((integration) => ({
    id: integration.id,
    kind: integration.kind,
    description: describeIntegration(integration),
  }));
  const watchlist = listWatchlist(db, userId);

  if (bucketName !== null && !getUserBucket(db, userId, bucketName)) {
    throw new Error(`Bucket not found: ${bucketName}`);
  }

  if (!hasPortfolioViewIntegrations(db, userId, bucketName)) {
    return {
      currency,
      bucketName,
      filter: filter ?? "all",
      hasIntegrations: false,
      buckets,
      integrations,
      watchlist,
      summary: null,
      holdings: [],
      allocation: [],
      sold: [],
      history: [],
      rsu: null,
      errors: [] as string[],
    };
  }

  // Fetch portfolio view ONCE (shared & coalesced with /api/portfolio/chart!)
  // instead of hitting IBKR/T212/F24 9 separate times in parallel.
  const baseLoader = options.runtime?.view ?? fetchPortfolioView;
  const sharedView = await getSharedPortfolioView(
    db,
    userId,
    bucketName,
    baseLoader,
    Boolean(options.refresh),
  );
  const cachedFetch = createCachedFxFetch(db, options.runtime?.request ?? fetch);
  const fastRuntime: ReportRuntime = {
    view: () => Promise.resolve(sharedView),
    request: cachedFetch,
    rsuQuotes: options.runtime?.rsuQuotes ?? fetchIntegratedIbkrStockQuotes,
    chart: options.runtime?.chart ?? loadAllTimeDataset,
  };

  const reportArgs = {
    userId,
    ...(bucketName ? { bucketName } : {}),
    ...(filter ? { filter } : {}),
  };

  const settled = await Promise.allSettled([
    runReport(db, "worth", reportArgs, fastRuntime),
    runReport(db, "dpnl", reportArgs, fastRuntime),
    runReport(db, "perf", reportArgs, fastRuntime),
    runReport(db, "alltime", reportArgs, fastRuntime),
    runReport(db, "stocks", reportArgs, fastRuntime),
    runReport(db, "options", reportArgs, fastRuntime),
    runReport(db, "portfolio", reportArgs, fastRuntime),
    runReport(db, "sold", reportArgs, fastRuntime),
    runReport(db, "history", reportArgs, fastRuntime),
    runReport(db, "rsu", { userId }, fastRuntime),
  ]);

  const errors: string[] = [];
  const unwrap = <T>(index: number, label: string): T | null => {
    const res = settled[index];
    if (res.status === "fulfilled") return res.value as T;
    const msg = res.reason instanceof Error ? res.reason.message : String(res.reason);
    errors.push(`${label}: ${msg}`);
    return null;
  };

  type WorthReport = {
    cash?: number;
    positions?: { ticker: string; value: number | null; returnPct: number | null; period: string | null }[];
    total?: { value: number | null; returnPct: number | null; period: string | null } | null;
  };
  type DpnlReport = {
    positions?: { ticker: string; pnl: number | null; returnPct: number | null; cached?: boolean }[];
    total?: { pnl: number | null; returnPct: number | null; incomplete?: boolean; cached?: boolean } | null;
  };
  type PerfReport = {
    positions?: { ticker: string; pnl: number | null; returnPct: number | null; period: string | null }[];
    total?: { pnl: number | null; returnPct: number | null; period: string | null } | null;
  };
  type AllTimeReport = {
    total?: {
      pnl: number | null;
      returnPct: number | null;
      contributedCapital: number | null;
      period: string | null;
    } | null;
  };
  type DetailedReport = {
    positions?: {
      ticker: string;
      pnl: number | null;
      returnPct: number | null;
      period: string | null;
      amount?: number;
      averagePrice?: number | null;
      currentPrice?: number | null;
      cost?: number | null;
      value?: number | null;
      monthlyPnl?: number | null;
      monthlyReturnPct?: number | null;
    }[];
  };
  type PortfolioAllocReport = {
    total?: number | null;
    holdings?: { ticker: string; weightPct: number; value: number; pnl: number | null; returnPct: number | null }[];
  };
  type SoldReport = {
    positions?: { ticker: string; pnl: number; returnPct: number; period: string | null }[];
    total?: { pnl: number; returnPct: number; period: string | null } | null;
  };
  type HistoryReport = {
    years?: {
      year: number;
      spent: number;
      purchases: { date: string; ticker: string; amount: number; price: number; spent: number }[];
    }[];
    total?: number | null;
  };

  const worth = unwrap<WorthReport>(0, "Net worth");
  const dpnl = unwrap<DpnlReport>(1, "Daily P/L");
  const perf = unwrap<PerfReport>(2, "Performance");
  const alltime = unwrap<AllTimeReport>(3, "All-time");
  const stocks = unwrap<DetailedReport>(4, "Stocks");
  const optionsReport = unwrap<DetailedReport>(5, "Options");
  const allocationReport = unwrap<PortfolioAllocReport>(6, "Allocation");
  const soldReport = unwrap<SoldReport>(7, "Sold");
  const historyReport = unwrap<HistoryReport>(8, "History");
  const rsuReport = unwrap<Record<string, unknown>>(9, "RSU");

  const dpnlByTicker = new Map<string, { pnl: number | null; returnPct: number | null; cached?: boolean }>();
  for (const p of dpnl?.positions ?? []) {
    dpnlByTicker.set(p.ticker.toUpperCase(), { pnl: p.pnl, returnPct: p.returnPct, cached: p.cached });
  }
  const allocByTicker = new Map<string, number>();
  for (const h of allocationReport?.holdings ?? []) {
    allocByTicker.set(h.ticker.toUpperCase(), h.weightPct);
  }

  const combinedHoldings = [
    ...(stocks?.positions ?? []).map((p) => ({ ...p, assetType: "stock" as const })),
    ...(optionsReport?.positions ?? []).map((p) => ({ ...p, assetType: "option" as const })),
  ];

  const totalHoldingsValue = combinedHoldings.reduce(
    (sum, item) => sum + (typeof item.value === "number" ? Math.abs(item.value) : 0),
    0,
  );

  const nativeByTicker = new Map<string, { currency: string; yahooSymbol?: string; exchange?: string }>();
  for (const pos of sharedView.positions) {
    nativeByTicker.set(pos.ticker.trim().toUpperCase(), {
      currency: pos.currency || "USD",
      yahooSymbol: pos.yahooSymbol,
      exchange: pos.exchange,
    });
  }

  const holdings = combinedHoldings
    .map((item) => {
      const key = item.ticker.toUpperCase();
      const nativeInfo = nativeByTicker.get(key);
      const daily = dpnlByTicker.get(key);
      const weightPct = allocByTicker.get(key) ??
        (totalHoldingsValue > 0 && typeof item.value === "number"
          ? (Math.abs(item.value) / totalHoldingsValue) * 100
          : null);
      const { displayTicker, optionMeta } = formatOptionDisplay(item.ticker);
      const yahooSymbol = guessYahooSymbol(
        db,
        item.ticker,
        nativeInfo?.currency ?? "USD",
        nativeInfo,
      );
      return {
        ticker: item.ticker,
        displayTicker,
        optionMeta,
        yahooSymbol,
        assetType: item.assetType,
        amount: item.amount ?? null,
        averagePrice: item.averagePrice ?? null,
        currentPrice: item.currentPrice ?? null,
        cost: item.cost ?? null,
        value: item.value ?? null,
        pnl: item.pnl ?? null,
        returnPct: item.returnPct ?? null,
        dailyPnl: daily?.pnl ?? null,
        dailyPct: daily?.returnPct ?? null,
        dailyCached: daily?.cached ?? false,
        weightPct,
        period: item.period ?? null,
      };
    })
    .sort((a, b) => Math.abs(b.value ?? 0) - Math.abs(a.value ?? 0));

  return {
    currency,
    bucketName,
    filter: filter ?? "all",
    hasIntegrations: true,
    buckets,
    integrations,
    watchlist,
    summary: {
      netWorth: worth?.total?.value ?? null,
      cash: typeof worth?.cash === "number" ? worth.cash : null,
      dailyPnl: dpnl?.total?.pnl ?? null,
      dailyPct: dpnl?.total?.returnPct ?? null,
      dailyIncomplete: dpnl?.total?.incomplete ?? false,
      dailyCached: dpnl?.total?.cached ?? false,
      openPnl: perf?.total?.pnl ?? null,
      openPct: perf?.total?.returnPct ?? null,
      openPeriod: perf?.total?.period ?? null,
      allTimePnl: alltime?.total?.pnl ?? null,
      allTimePct: alltime?.total?.returnPct ?? null,
      contributedCapital: alltime?.total?.contributedCapital ?? null,
      allTimePeriod: alltime?.total?.period ?? null,
    },
    holdings,
    allocation: allocationReport?.holdings ?? [],
    sold: soldReport?.positions ?? [],
    soldTotal: soldReport?.total ?? null,
    history: historyReport?.years ?? [],
    historyTotal: historyReport?.total ?? null,
    rsu: rsuReport,
    errors,
  };
}

function computePersonalKeyPoints(points: PersonalChartPoint[]): PersonalChartKeyPoints {
  let peakValue: { date: string; value: number } | null = null;
  let troughValue: { date: string; value: number } | null = null;
  let peakReturn: { date: string; value: number } | null = null;
  let troughReturn: { date: string; value: number } | null = null;
  let bestDay: { date: string; delta: number } | null = null;
  let worstDay: { date: string; delta: number } | null = null;

  let runningPeak: { date: string; value: number } | null = null;
  let maxDrawdown: { pct: number; peakDate: string; troughDate: string } | null = null;

  let prevValue: number | null = null;
  for (const p of points) {
    if (p.value !== null && Number.isFinite(p.value)) {
      if (!peakValue || p.value > peakValue.value) peakValue = { date: p.date, value: p.value };
      if (!troughValue || p.value < troughValue.value) troughValue = { date: p.date, value: p.value };
      if (prevValue !== null) {
        const delta = p.value - prevValue;
        if (!bestDay || delta > bestDay.delta) bestDay = { date: p.date, delta };
        if (!worstDay || delta < worstDay.delta) worstDay = { date: p.date, delta };
      }
      prevValue = p.value;
    }
    if (p.returnPct !== null && Number.isFinite(p.returnPct)) {
      if (!peakReturn || p.returnPct > peakReturn.value) peakReturn = { date: p.date, value: p.returnPct };
      if (!troughReturn || p.returnPct < troughReturn.value) troughReturn = { date: p.date, value: p.returnPct };
      const wealthIndex = 1 + p.returnPct / 100;
      if (wealthIndex > 0) {
        if (!runningPeak || wealthIndex > runningPeak.value) {
          runningPeak = { date: p.date, value: wealthIndex };
        } else {
          const ddPct = ((wealthIndex - runningPeak.value) / runningPeak.value) * 100;
          if (!maxDrawdown || ddPct < maxDrawdown.pct) {
            maxDrawdown = {
              pct: ddPct,
              peakDate: runningPeak.date,
              troughDate: p.date,
            };
          }
        }
      }
    }
  }

  return { peakValue, troughValue, peakReturn, troughReturn, maxDrawdown, bestDay, worstDay };
}

export async function loadWebPersonalChart(
  db: Database,
  userId: number,
  options: {
    kind?: WebPersonalChartKind;
    filter?: ReportFilter;
    bucketName?: string | null;
    benchmark?: WebBenchmarkOption;
    refresh?: boolean;
    request?: typeof fetch;
    viewLoader?: typeof fetchPortfolioView;
    datasetLoader?: typeof loadAllTimeDataset;
  } = {},
): Promise<WebPersonalChartResponse> {
  const user = readUser(db, userId);
  if (!user) throw new Error("User not found.");
  const currency = user.currency ?? "USD";
  const kind: WebPersonalChartKind = options.kind ?? "alltime";
  const filter = options.filter;
  const bucketName = options.bucketName ?? null;
  const benchmarkOption: WebBenchmarkOption = options.benchmark ?? "sp500";
  const request = createCachedFxFetch(db, options.request ?? fetch);
  const viewLoader = options.viewLoader ?? fetchPortfolioView;
  const datasetLoader = options.datasetLoader ?? loadAllTimeDataset;

  if (options.refresh) clearUserPortfolioCaches(db, userId);

  if (bucketName !== null && !getUserBucket(db, userId, bucketName)) {
    throw new Error(`Bucket not found: ${bucketName}`);
  }
  if (!hasPortfolioViewIntegrations(db, userId, bucketName)) {
    return {
      currency,
      kind,
      filter: filter ?? "all",
      bucketName,
      benchmark: benchmarkOption,
      benchmarkLabel: null,
      hasBenchmark: false,
      notes: ["No broker integrations configured yet. Use /integrations in Telegram to connect an account."],
      purchaseDates: [],
      points: [],
      keyPoints: computePersonalKeyPoints([]),
    };
  }

  const useCache = viewLoader === fetchPortfolioView && datasetLoader === loadAllTimeDataset;
  const datasetCache = getDbCache(db).datasets;
  const datasetKey = `${userId}:${bucketName ?? ""}:${kind}:${filter ?? "all"}`;
  const now = Date.now();

  const buildFreshDataset = async (forceViewRefresh: boolean): Promise<AllTimeDataset> => {
    const rawView = await getSharedPortfolioView(
      db,
      userId,
      bucketName,
      viewLoader,
      forceViewRefresh,
    );
    const matches = filter === "stocks"
      ? isStockPosition
      : filter === "options"
      ? isOptionPosition
      : () => true;
    const view = {
      ...rawView,
      positions: rawView.positions.filter(matches),
      orders: rawView.orders.filter(matches),
      ...(filter ? { accountPerformances: [] } : {}),
    };
    const built = await datasetLoader(
      db,
      { ...view, benchmarkSource: rawView, kind, filter },
      userId,
      String(userId),
      undefined,
      request,
    );
    if (useCache) {
      writePersistentChartCache(db, datasetKey, userId, built);
    }
    return built;
  };

  let dataset: AllTimeDataset;
  let cached = false;
  let refreshing = false;
  let updatedAt: string | undefined;

  const cachedEntry = useCache ? datasetCache.get(datasetKey) : undefined;
  if (cachedEntry && cachedEntry.expiresAt > now && (!options.refresh || now - cachedEntry.createdAt <= 2_000)) {
    dataset = await cachedEntry.promise;
    cached = true;
    updatedAt = new Date(cachedEntry.createdAt).toISOString();
  } else {
    // Stale-while-revalidate: serve persisted SQLite snapshot immediately (<15ms)
    // and kick off a background refresh when stale!
    const persisted = useCache && !options.refresh
      ? readPersistentChartCache(db, datasetKey)
      : null;
    const seededFromTelegram = !persisted && useCache && !options.refresh
      ? readTelegramSavedChartDataset(db, userId, bucketName, kind, filter)
      : null;

    if (persisted || seededFromTelegram) {
      dataset = persisted ? persisted.dataset : seededFromTelegram!;
      cached = true;
      updatedAt = persisted?.updatedAt;
      const isStale = !persisted || persisted.ageMs > PERSISTENT_CHART_FRESH_MS;
      if (isStale) {
        let inflight = backgroundChartRefreshes.get(db);
        if (!inflight) {
          inflight = new Map();
          backgroundChartRefreshes.set(db, inflight);
        }
        refreshing = true;
        if (!inflight.has(datasetKey)) {
          const job = buildFreshDataset(false)
            .then((fresh) => {
              datasetCache.set(datasetKey, {
                createdAt: Date.now(),
                expiresAt: Date.now() + DATASET_CACHE_TTL_MS,
                promise: Promise.resolve(fresh),
              });
            })
            .catch((err) => {
              console.warn(`Background personal chart refresh failed (${datasetKey}):`, err);
            })
            .finally(() => {
              inflight!.delete(datasetKey);
            });
          inflight.set(datasetKey, job);
        }
      }
    } else {
      const buildPromise = buildFreshDataset(Boolean(options.refresh)).catch((error) => {
        if (datasetCache.get(datasetKey)?.promise === buildPromise) {
          datasetCache.delete(datasetKey);
        }
        throw error;
      });
      if (useCache) {
        datasetCache.set(datasetKey, {
          createdAt: now,
          expiresAt: now + DATASET_CACHE_TTL_MS,
          promise: buildPromise,
        });
      }
      dataset = await buildPromise;
      updatedAt = new Date().toISOString();
    }
  }

  if (
    benchmarkOption !== "none" &&
    benchmarkOption !== dataset.benchmarkIndex &&
    dataset.benchmarkPurchases &&
    (dataset.benchmark || dataset.benchmarkInputsReady)
  ) {
    try {
      const [switched] = await switchChartBenchmarks(db, [dataset], benchmarkOption);
      if (switched) {
        dataset = switched;
        if (useCache) {
          datasetCache.set(datasetKey, {
            createdAt: now,
            expiresAt: now + DATASET_CACHE_TTL_MS,
            promise: Promise.resolve(dataset),
          });
          writePersistentChartCache(db, datasetKey, userId, dataset);
        }
      }
    } catch (error) {
      dataset = {
        ...dataset,
        benchmark: undefined,
        notes: [
          ...(dataset.notes ?? []),
          `Benchmark unavailable: ${error instanceof Error ? error.message : String(error)}`,
        ],
      };
    }
  }

  const rate = conversionFactor(
    "USD",
    await fetchConversionRates(["USD"], currency, request),
  );

  const benchByDate = new Map<string, { value: number | null; pct: number | null }>();
  const activeBenchmark = benchmarkOption === "none" ? undefined : dataset.benchmark;
  if (activeBenchmark) {
    for (const bp of activeBenchmark.points) {
      const rawVal = kind === "worth" ? (bp.value ?? bp.gain) : bp.gain;
      benchByDate.set(bp.date, {
        value: typeof rawVal === "number" && Number.isFinite(rawVal) ? rawVal * rate : null,
        pct: typeof bp.percentage === "number" && Number.isFinite(bp.percentage) ? bp.percentage : null,
      });
    }
  }

  const points: PersonalChartPoint[] = dataset.points.map((p) => {
    const bench = benchByDate.get(p.date);
    return {
      date: p.date,
      value: p.gain === null ? null : p.gain * rate,
      returnPct: p.percentage,
      benchmarkValue: bench?.value ?? null,
      benchmarkReturnPct: bench?.pct ?? null,
    };
  });

  return {
    currency,
    kind,
    filter: filter ?? "all",
    bucketName,
    benchmark: benchmarkOption,
    benchmarkLabel: activeBenchmark?.label ?? null,
    hasBenchmark: Boolean(activeBenchmark && activeBenchmark.points.length),
    notes: dataset.notes ?? [],
    purchaseDates: dataset.purchaseDates ?? [],
    points,
    keyPoints: computePersonalKeyPoints(points),
    ...(cached ? { cached: true } : {}),
    ...(refreshing ? { refreshing: true } : {}),
    ...(updatedAt ? { updatedAt } : {}),
  };
}

export async function loadUserTickerContext(
  db: Database,
  userId: number,
  rawSymbol: string,
  runtime?: ReportRuntime,
): Promise<UserTickerContext | null> {
  const symbol = sanitizeSymbol(rawSymbol);
  if (!symbol) return null;
  const user = readUser(db, userId);
  if (!user || !hasPortfolioViewIntegrations(db, userId, null)) return null;
  const currency = user.currency ?? "USD";

  const matchesSymbol = (ticker: string) => {
    const norm = ticker.trim().toUpperCase();
    if (norm === symbol) return true;
    const mapped = readYahooMapping(db, norm)?.toUpperCase();
    if (mapped && mapped === symbol) return true;
    const base = symbol.split(".")[0];
    if (norm === base && symbol.includes(".")) return true;
    return false;
  };

  try {
    const sharedView = await getSharedPortfolioView(
      db,
      userId,
      null,
      runtime?.view ?? fetchPortfolioView,
    );
    const cachedFetch = createCachedFxFetch(db, runtime?.request ?? fetch);
    const fastRuntime: ReportRuntime = {
      view: () => Promise.resolve(sharedView),
      request: cachedFetch,
      rsuQuotes: runtime?.rsuQuotes ?? fetchIntegratedIbkrStockQuotes,
      chart: runtime?.chart ?? loadAllTimeDataset,
    };

    const [stocksRes, dpnlRes] = await Promise.allSettled([
      runReport(db, "stocks", { userId }, fastRuntime),
      runReport(db, "dpnl", { userId }, fastRuntime),
    ]);

    let position: UserTickerContext["position"] = null;
    if (stocksRes.status === "fulfilled") {
      const positions = (stocksRes.value as { positions?: Record<string, unknown>[] }).positions ?? [];
      const found = positions.find((p) => typeof p.ticker === "string" && matchesSymbol(p.ticker));
      if (found) {
        let dailyPnl: number | null = null;
        let dailyPct: number | null = null;
        if (dpnlRes.status === "fulfilled") {
          const dPositions = (dpnlRes.value as { positions?: Record<string, unknown>[] }).positions ?? [];
          const dFound = dPositions.find((p) => typeof p.ticker === "string" && matchesSymbol(p.ticker));
          if (dFound) {
            dailyPnl = typeof dFound.pnl === "number" ? dFound.pnl : null;
            dailyPct = typeof dFound.returnPct === "number" ? dFound.returnPct : null;
          }
        }
        position = {
          ticker: String(found.ticker),
          amount: Number(found.amount ?? 0),
          averagePrice: typeof found.averagePrice === "number" ? found.averagePrice : null,
          currentPrice: typeof found.currentPrice === "number" ? found.currentPrice : null,
          cost: typeof found.cost === "number" ? found.cost : null,
          value: typeof found.value === "number" ? found.value : null,
          pnl: typeof found.pnl === "number" ? found.pnl : null,
          returnPct: typeof found.returnPct === "number" ? found.returnPct : null,
          dailyPnl,
          dailyPct,
          period: typeof found.period === "string" ? found.period : null,
        };
      }
    }

    const trades: UserTickerTrade[] = [];
    const orders = sharedView.orders.length ? sharedView.orders : sharedView.historyOrders;
    for (const order of orders) {
      if (!matchesSymbol(order.ticker) || !order.quantity) continue;
      trades.push({
        date: order.date.toISOString().slice(0, 10),
        side: order.quantity > 0 ? "buy" : "sell",
        quantity: Math.abs(order.quantity),
        price: order.price,
        currency: order.currency,
      });
    }
    trades.sort((a, b) => a.date.localeCompare(b.date));

    if (!position && !trades.length) return null;
    return { symbol, currency, position, trades };
  } catch {
    return null;
  }
}
