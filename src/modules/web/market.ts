import { logFetch } from "../../utils/fetch_logging.ts";
import { quoteCurrency } from "../market_data/yahoo.ts";

export type TickerRange = "1d" | "5d" | "1m" | "3m" | "6m" | "ytd" | "1y" | "5y" | "max";
export type MarketSessionState = "PRE" | "REGULAR" | "POST" | "CLOSED" | "OPEN_24_7";
export type BarSession = "pre" | "regular" | "post";

export type TradingWindow = {
  start: number; // unix seconds
  end: number; // unix seconds
};

export type MarketStatus = {
  state: MarketSessionState;
  isOpenNow: boolean;
  isRegularOpen: boolean;
  isExtendedHours: boolean;
  label: string;
  detail: string;
  timezone: string;
  timezoneShort: string;
  nextTransitionAt: number | null; // unix ms
  nextTransitionLabel: string | null;
  nextRegularOpenAt: number | null; // unix ms
  nextRegularCloseAt: number | null; // unix ms
  schedule: {
    pre: { start: number; end: number } | null; // unix ms
    regular: { start: number; end: number } | null; // unix ms
    post: { start: number; end: number } | null; // unix ms
  };
};

export type TickerBar = {
  time: number; // unix ms
  date: string; // YYYY-MM-DD in exchange TZ
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number | null;
  session: BarSession;
};

export type TickerKeyPoint = {
  time: number;
  date: string;
  price: number;
};

export type TickerDividend = {
  time: number;
  date: string;
  amount: number;
};

export type TickerSplit = {
  time: number;
  date: string;
  ratio: number;
  label: string;
};

export type TickerChartData = {
  symbol: string;
  name: string;
  exchange: string;
  instrumentType: string;
  currency: string;
  timezone: string;
  range: TickerRange;
  interval: string;
  intraday: boolean;
  price: number;
  previousClose: number | null;
  change: number | null;
  changePct: number | null;
  regularPrice: number;
  regularChange: number | null;
  regularChangePct: number | null;
  extended: {
    session: "pre" | "post";
    price: number;
    change: number | null;
    changePct: number | null;
    time: number | null;
  } | null;
  stats: {
    open: number | null;
    dayHigh: number | null;
    dayLow: number | null;
    volume: number | null;
    fiftyTwoWeekHigh: number | null;
    fiftyTwoWeekLow: number | null;
    periodOpen: number | null;
    periodClose: number | null;
    periodChange: number | null;
    periodChangePct: number | null;
    periodHigh: TickerKeyPoint | null;
    periodLow: TickerKeyPoint | null;
  };
  marketStatus: MarketStatus;
  bars: TickerBar[];
  dividends: TickerDividend[];
  splits: TickerSplit[];
};

export type TickerSearchResult = {
  symbol: string;
  name: string;
  exchange: string;
  quoteType: string;
};

export type TickerSnapshot = {
  symbol: string;
  name: string;
  exchange: string;
  currency: string;
  instrumentType: string;
  price: number | null;
  previousClose: number | null;
  change: number | null;
  changePct: number | null;
  extended: {
    session: "pre" | "post";
    price: number;
    changePct: number | null;
  } | null;
  marketStatus: MarketStatus | null;
  sparkline: number[];
  error?: string;
};

const YAHOO_HEADERS = {
  "User-Agent": "Mozilla/5.0 Eyri/1.0",
  Accept: "application/json",
};

const RANGE_CONFIG: Record<TickerRange, { yahooRange: string; interval: string; intraday: boolean }> = {
  "1d": { yahooRange: "1d", interval: "2m", intraday: true },
  "5d": { yahooRange: "5d", interval: "15m", intraday: true },
  "1m": { yahooRange: "1mo", interval: "1d", intraday: false },
  "3m": { yahooRange: "3mo", interval: "1d", intraday: false },
  "6m": { yahooRange: "6mo", interval: "1d", intraday: false },
  "ytd": { yahooRange: "ytd", interval: "1d", intraday: false },
  "1y": { yahooRange: "1y", interval: "1d", intraday: false },
  "5y": { yahooRange: "5y", interval: "1wk", intraday: false },
  "max": { yahooRange: "max", interval: "1mo", intraday: false },
};

export function isValidTickerRange(value: string): value is TickerRange {
  return Object.prototype.hasOwnProperty.call(RANGE_CONFIG, value);
}

export function sanitizeSymbol(raw: string): string | null {
  const cleaned = raw.trim().toUpperCase();
  if (!cleaned || cleaned.length > 32) return null;
  if (!/^[A-Z0-9.^=\-_:/]+$/.test(cleaned)) return null;
  return cleaned;
}

function formatDateInTz(unixSeconds: number, timezone: string): string {
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date(unixSeconds * 1000));
  } catch {
    return new Date(unixSeconds * 1000).toISOString().slice(0, 10);
  }
}

function formatTimeInTz(unixMs: number, timezone: string): string {
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(new Date(unixMs));
  } catch {
    return new Date(unixMs).toISOString().slice(11, 16);
  }
}

function timezoneShortName(unixMs: number, timezone: string): string {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      timeZoneName: "short",
    }).formatToParts(new Date(unixMs));
    return parts.find((p) => p.type === "timeZoneName")?.value ?? timezone;
  } catch {
    return timezone;
  }
}

function weekdayInTz(unixMs: number, timezone: string): number {
  try {
    const name = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      weekday: "short",
    }).format(new Date(unixMs));
    const map: Record<string, number> = {
      Sun: 0,
      Mon: 1,
      Tue: 2,
      Wed: 3,
      Thu: 4,
      Fri: 5,
      Sat: 6,
    };
    return map[name] ?? new Date(unixMs).getUTCDay();
  } catch {
    return new Date(unixMs).getUTCDay();
  }
}

export function formatDurationCompact(ms: number): string {
  const totalMinutes = Math.max(0, Math.ceil(ms / 60_000));
  const days = Math.floor(totalMinutes / (60 * 24));
  const hours = Math.floor((totalMinutes % (60 * 24)) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) {
    return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  }
  if (hours > 0) {
    return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  }
  return `${Math.max(1, minutes)}m`;
}

function advanceToNextWeekday(unixMs: number, nowMs: number, timezone: string): number {
  const DAY = 86_400_000;
  let candidate = unixMs;
  let guard = 0;
  while ((candidate <= nowMs || [0, 6].includes(weekdayInTz(candidate, timezone))) && guard < 10) {
    candidate += DAY;
    guard++;
  }
  return candidate;
}

export type RawTradingPeriods = {
  pre?: { start?: number; end?: number; timezone?: string };
  regular?: { start?: number; end?: number; timezone?: string };
  post?: { start?: number; end?: number; timezone?: string };
};

export function computeMarketSession(
  params: {
    instrumentType?: string;
    timezone?: string;
    currentTradingPeriod?: RawTradingPeriods;
    nowMs?: number;
  },
): MarketStatus {
  const nowMs = params.nowMs ?? Date.now();
  const nowSec = nowMs / 1000;
  const timezone = params.timezone || "America/New_York";
  const tzShort = timezoneShortName(nowMs, timezone);
  const instrumentType = (params.instrumentType ?? "").toUpperCase();

  if (instrumentType === "CRYPTOCURRENCY") {
    return {
      state: "OPEN_24_7",
      isOpenNow: true,
      isRegularOpen: true,
      isExtendedHours: false,
      label: "Open 24/7",
      detail: "Crypto market trades continuously",
      timezone,
      timezoneShort: tzShort,
      nextTransitionAt: null,
      nextTransitionLabel: null,
      nextRegularOpenAt: null,
      nextRegularCloseAt: null,
      schedule: { pre: null, regular: null, post: null },
    };
  }

  const validWindow = (w?: { start?: number; end?: number }): TradingWindow | null => {
    if (!w || typeof w.start !== "number" || typeof w.end !== "number") return null;
    if (!Number.isFinite(w.start) || !Number.isFinite(w.end) || w.end <= w.start) return null;
    return { start: w.start, end: w.end };
  };

  const pre = validWindow(params.currentTradingPeriod?.pre);
  const regular = validWindow(params.currentTradingPeriod?.regular);
  const post = validWindow(params.currentTradingPeriod?.post);

  const schedule = {
    pre: pre ? { start: pre.start * 1000, end: pre.end * 1000 } : null,
    regular: regular ? { start: regular.start * 1000, end: regular.end * 1000 } : null,
    post: post ? { start: post.start * 1000, end: post.end * 1000 } : null,
  };

  if (regular && nowSec >= regular.start && nowSec < regular.end) {
    const closeMs = regular.end * 1000;
    const closeTime = formatTimeInTz(closeMs, timezone);
    return {
      state: "REGULAR",
      isOpenNow: true,
      isRegularOpen: true,
      isExtendedHours: false,
      label: "Market Open",
      detail: `Closes in ${formatDurationCompact(closeMs - nowMs)} · ${closeTime} ${tzShort}`,
      timezone,
      timezoneShort: tzShort,
      nextTransitionAt: closeMs,
      nextTransitionLabel: `Closes at ${closeTime} ${tzShort}`,
      nextRegularOpenAt: null,
      nextRegularCloseAt: closeMs,
      schedule,
    };
  }

  if (pre && nowSec >= pre.start && nowSec < pre.end) {
    const openMs = (regular?.start ?? pre.end) * 1000;
    const openTime = formatTimeInTz(openMs, timezone);
    return {
      state: "PRE",
      isOpenNow: true,
      isRegularOpen: false,
      isExtendedHours: true,
      label: "Pre-Market",
      detail: `Regular opens in ${formatDurationCompact(openMs - nowMs)} · ${openTime} ${tzShort}`,
      timezone,
      timezoneShort: tzShort,
      nextTransitionAt: openMs,
      nextTransitionLabel: `Regular opens at ${openTime} ${tzShort}`,
      nextRegularOpenAt: openMs,
      nextRegularCloseAt: regular ? regular.end * 1000 : null,
      schedule,
    };
  }

  if (post && nowSec >= post.start && nowSec < post.end) {
    const endMs = post.end * 1000;
    const endTime = formatTimeInTz(endMs, timezone);
    const nextRegularOpenAt = regular ? advanceToNextWeekday(regular.start * 1000, nowMs, timezone) : null;
    return {
      state: "POST",
      isOpenNow: true,
      isRegularOpen: false,
      isExtendedHours: true,
      label: "After-Hours",
      detail: `Ends in ${formatDurationCompact(endMs - nowMs)} · ${endTime} ${tzShort}`,
      timezone,
      timezoneShort: tzShort,
      nextTransitionAt: endMs,
      nextTransitionLabel: `After-hours ends at ${endTime} ${tzShort}`,
      nextRegularOpenAt,
      nextRegularCloseAt: null,
      schedule,
    };
  }

  // Market is closed. Compute the next regular open (and pre-market open if earlier).
  const nextRegularOpenAt = regular
    ? (regular.start * 1000 > nowMs && ![0, 6].includes(weekdayInTz(regular.start * 1000, timezone))
      ? regular.start * 1000
      : advanceToNextWeekday(regular.start * 1000, nowMs, timezone))
    : null;
  const nextPreOpenAt = pre && regular && pre.start < regular.start
    ? (pre.start * 1000 > nowMs && ![0, 6].includes(weekdayInTz(pre.start * 1000, timezone))
      ? pre.start * 1000
      : advanceToNextWeekday(pre.start * 1000, nowMs, timezone))
    : null;

  const nextTransitionAt = nextRegularOpenAt;
  let detail = "Market currently closed";
  let nextTransitionLabel: string | null = null;
  if (nextRegularOpenAt !== null) {
    const openTime = formatTimeInTz(nextRegularOpenAt, timezone);
    const dayPrefix = formatDateInTz(nextRegularOpenAt / 1000, timezone) === formatDateInTz(nowMs / 1000, timezone)
      ? ""
      : `${new Intl.DateTimeFormat("en-US", { timeZone: timezone, weekday: "short" }).format(new Date(nextRegularOpenAt))} `;
    detail = `Opens in ${formatDurationCompact(nextRegularOpenAt - nowMs)} · ${dayPrefix}${openTime} ${tzShort}`;
    if (nextPreOpenAt !== null && nextPreOpenAt < nextRegularOpenAt && nextPreOpenAt > nowMs) {
      const preTime = formatTimeInTz(nextPreOpenAt, timezone);
      nextTransitionLabel = `Pre-market ${dayPrefix}${preTime} · Regular ${openTime} ${tzShort}`;
    } else {
      nextTransitionLabel = `Opens ${dayPrefix}${openTime} ${tzShort}`;
    }
  }

  return {
    state: "CLOSED",
    isOpenNow: false,
    isRegularOpen: false,
    isExtendedHours: false,
    label: "Market Closed",
    detail,
    timezone,
    timezoneShort: tzShort,
    nextTransitionAt,
    nextTransitionLabel,
    nextRegularOpenAt,
    nextRegularCloseAt: null,
    schedule,
  };
}

function classifyBarSession(
  unixSec: number,
  intraday: boolean,
  regularPeriods: TradingWindow[],
  prePeriods: TradingWindow[],
  postPeriods: TradingWindow[],
): BarSession {
  if (!intraday) return "regular";
  for (const w of regularPeriods) {
    if (unixSec >= w.start && unixSec < w.end) return "regular";
  }
  for (const w of prePeriods) {
    if (unixSec >= w.start && unixSec < w.end) return "pre";
  }
  for (const w of postPeriods) {
    if (unixSec >= w.start && unixSec < w.end) return "post";
  }
  // Fallback: compare against nearest regular window on the same day.
  for (const w of regularPeriods) {
    if (Math.abs(unixSec - w.start) < 12 * 3600) {
      if (unixSec < w.start) return "pre";
      if (unixSec >= w.end) return "post";
    }
  }
  return "regular";
}

function extractPeriods(raw: unknown): TradingWindow[] {
  if (!Array.isArray(raw)) return [];
  const windows: TradingWindow[] = [];
  for (const item of raw) {
    if (Array.isArray(item)) {
      for (const nested of item) {
        if (nested && typeof nested.start === "number" && typeof nested.end === "number") {
          windows.push({ start: nested.start, end: nested.end });
        }
      }
    } else if (item && typeof item.start === "number" && typeof item.end === "number") {
      windows.push({ start: item.start, end: item.end });
    }
  }
  return windows;
}

const finiteOrNull = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

async function yahooJson(url: string, request: typeof fetch, label: string) {
  return logFetch(`Web Yahoo ${label}`, async () => {
    const response = await request(url, {
      headers: YAHOO_HEADERS,
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`Yahoo Finance returned HTTP ${response.status} for ${label}.`);
    }
    return await response.json();
  });
}

type CacheEntry<T> = { expiresAt: number; value: T };
const searchCache = new Map<string, CacheEntry<TickerSearchResult[]>>();
const chartCache = new Map<string, CacheEntry<TickerChartData>>();
const snapshotCache = new Map<string, CacheEntry<TickerSnapshot>>();

export function clearMarketCaches() {
  searchCache.clear();
  chartCache.clear();
  snapshotCache.clear();
}

export async function searchTickers(
  query: string,
  request: typeof fetch = fetch,
  nowMs = Date.now(),
): Promise<TickerSearchResult[]> {
  const trimmed = query.trim();
  if (!trimmed || trimmed.length > 64) return [];
  const cacheKey = trimmed.toUpperCase();
  const cached = searchCache.get(cacheKey);
  if (cached && cached.expiresAt > nowMs) return cached.value;

  const url = new URL("https://query1.finance.yahoo.com/v1/finance/search");
  url.searchParams.set("q", trimmed);
  url.searchParams.set("quotesCount", "12");
  url.searchParams.set("newsCount", "0");
  url.searchParams.set("enableFuzzyQuery", "true");

  const data = await yahooJson(String(url), request, `search ${trimmed}`);
  const allowedTypes = new Set([
    "EQUITY",
    "ETF",
    "INDEX",
    "CRYPTOCURRENCY",
    "CURRENCY",
    "FUTURE",
    "MUTUALFUND",
    "OPTION",
  ]);
  const results: TickerSearchResult[] = [];
  for (const item of data?.quotes ?? []) {
    if (typeof item?.symbol !== "string") continue;
    const quoteType = typeof item.quoteType === "string" ? item.quoteType.toUpperCase() : "EQUITY";
    if (!allowedTypes.has(quoteType)) continue;
    results.push({
      symbol: item.symbol,
      name: String(item.shortname || item.longname || item.symbol),
      exchange: String(item.exchDisp || item.exchange || ""),
      quoteType,
    });
  }
  searchCache.set(cacheKey, { expiresAt: nowMs + 60_000, value: results });
  if (searchCache.size > 200) {
    const oldestKey = searchCache.keys().next().value;
    if (oldestKey) searchCache.delete(oldestKey);
  }
  return results;
}

export async function fetchTickerChart(
  rawSymbol: string,
  range: TickerRange = "1d",
  request: typeof fetch = fetch,
  nowMs = Date.now(),
): Promise<TickerChartData> {
  const symbol = sanitizeSymbol(rawSymbol);
  if (!symbol) throw new Error("Invalid ticker symbol.");
  const config = RANGE_CONFIG[range];
  const cacheKey = `${symbol}:${range}`;
  const cached = chartCache.get(cacheKey);
  if (cached && cached.expiresAt > nowMs) return cached.value;

  const url = new URL(
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}`,
  );
  url.searchParams.set("range", config.yahooRange);
  url.searchParams.set("interval", config.interval);
  url.searchParams.set("includePrePost", config.intraday ? "true" : "false");
  url.searchParams.set("events", "div,splits");

  const data = await yahooJson(String(url), request, `chart ${symbol} ${range}`);
  const result = data?.chart?.result?.[0];
  if (data?.chart?.error || !result?.meta) {
    const desc = data?.chart?.error?.description;
    throw new Error(desc || `Ticker "${symbol}" was not found.`);
  }

  const meta = result.meta;
  const timezone = String(meta.exchangeTimezoneName || "America/New_York");
  const currency = meta.currency ? quoteCurrency(String(meta.currency)) : "USD";
  const instrumentType = String(meta.instrumentType || "EQUITY").toUpperCase();
  const marketStatus = computeMarketSession({
    instrumentType,
    timezone,
    currentTradingPeriod: meta.currentTradingPeriod,
    nowMs,
  });

  const tradingPeriods = result.meta?.tradingPeriods ?? {};
  const regularPeriods = extractPeriods(tradingPeriods.regular);
  if (!regularPeriods.length && meta.currentTradingPeriod?.regular) {
    regularPeriods.push({
      start: meta.currentTradingPeriod.regular.start,
      end: meta.currentTradingPeriod.regular.end,
    });
  }
  const prePeriods = extractPeriods(tradingPeriods.pre);
  if (!prePeriods.length && meta.currentTradingPeriod?.pre) {
    prePeriods.push({
      start: meta.currentTradingPeriod.pre.start,
      end: meta.currentTradingPeriod.pre.end,
    });
  }
  const postPeriods = extractPeriods(tradingPeriods.post);
  if (!postPeriods.length && meta.currentTradingPeriod?.post) {
    postPeriods.push({
      start: meta.currentTradingPeriod.post.start,
      end: meta.currentTradingPeriod.post.end,
    });
  }

  const timestamps: unknown[] = Array.isArray(result.timestamp) ? result.timestamp : [];
  const quote = result.indicators?.quote?.[0] ?? {};
  const opens: unknown[] = Array.isArray(quote.open) ? quote.open : [];
  const highs: unknown[] = Array.isArray(quote.high) ? quote.high : [];
  const lows: unknown[] = Array.isArray(quote.low) ? quote.low : [];
  const closes: unknown[] = Array.isArray(quote.close) ? quote.close : [];
  const volumes: unknown[] = Array.isArray(quote.volume) ? quote.volume : [];

  const bars: TickerBar[] = [];
  for (let i = 0; i < timestamps.length; i++) {
    const ts = finiteOrNull(timestamps[i]);
    const close = finiteOrNull(closes[i]);
    if (ts === null || close === null) continue;
    const open = finiteOrNull(opens[i]) ?? close;
    const high = finiteOrNull(highs[i]) ?? Math.max(open, close);
    const low = finiteOrNull(lows[i]) ?? Math.min(open, close);
    const volume = finiteOrNull(volumes[i]);
    const session = classifyBarSession(ts, config.intraday, regularPeriods, prePeriods, postPeriods);
    bars.push({
      time: ts * 1000,
      date: formatDateInTz(ts, timezone),
      open,
      high,
      low,
      close,
      volume,
      session,
    });
  }

  const regularPrice = finiteOrNull(meta.regularMarketPrice) ?? bars.at(-1)?.close ?? 0;
  const previousClose = finiteOrNull(meta.previousClose) ?? finiteOrNull(meta.chartPreviousClose);
  const regularChange = previousClose !== null && previousClose !== 0
    ? regularPrice - previousClose
    : null;
  const regularChangePct = previousClose !== null && previousClose !== 0 && regularChange !== null
    ? (regularChange / previousClose) * 100
    : null;

  // Determine extended-hours quote if available from meta or latest pre/post bar.
  let extended: TickerChartData["extended"] = null;
  const metaPrePrice = finiteOrNull(meta.preMarketPrice);
  const metaPostPrice = finiteOrNull(meta.postMarketPrice);
  if (marketStatus.state === "PRE" || (marketStatus.state === "CLOSED" && metaPrePrice !== null && !metaPostPrice)) {
    const extPrice = metaPrePrice ?? bars.findLast((b) => b.session === "pre")?.close ?? null;
    if (extPrice !== null && previousClose !== null) {
      const chg = extPrice - previousClose;
      extended = {
        session: "pre",
        price: extPrice,
        change: chg,
        changePct: previousClose !== 0 ? (chg / previousClose) * 100 : null,
        time: finiteOrNull(meta.preMarketTime) ? Number(meta.preMarketTime) * 1000 : null,
      };
    }
  } else if (marketStatus.state === "POST" || (marketStatus.state === "CLOSED" && metaPostPrice !== null)) {
    const extPrice = metaPostPrice ?? bars.findLast((b) => b.session === "post")?.close ?? null;
    if (extPrice !== null) {
      const chg = extPrice - regularPrice;
      extended = {
        session: "post",
        price: extPrice,
        change: chg,
        changePct: regularPrice !== 0 ? (chg / regularPrice) * 100 : null,
        time: finiteOrNull(meta.postMarketTime) ? Number(meta.postMarketTime) * 1000 : null,
      };
    }
  } else if (config.intraday) {
    const lastBar = bars.at(-1);
    if (lastBar && lastBar.session !== "regular") {
      const base = lastBar.session === "post" ? regularPrice : (previousClose ?? regularPrice);
      const chg = lastBar.close - base;
      extended = {
        session: lastBar.session,
        price: lastBar.close,
        change: chg,
        changePct: base !== 0 ? (chg / base) * 100 : null,
        time: lastBar.time,
      };
    }
  }

  let periodHigh: TickerKeyPoint | null = null;
  let periodLow: TickerKeyPoint | null = null;
  for (const bar of bars) {
    if (!periodHigh || bar.high > periodHigh.price) {
      periodHigh = { time: bar.time, date: bar.date, price: bar.high };
    }
    if (!periodLow || bar.low < periodLow.price) {
      periodLow = { time: bar.time, date: bar.date, price: bar.low };
    }
  }

  const periodOpen = range === "1d" && previousClose !== null
    ? previousClose
    : bars[0]?.open ?? null;
  const periodClose = bars.at(-1)?.close ?? regularPrice;
  const periodChange = periodOpen !== null ? periodClose - periodOpen : null;
  const periodChangePct = periodOpen !== null && periodOpen !== 0 && periodChange !== null
    ? (periodChange / periodOpen) * 100
    : null;

  const dividends: TickerDividend[] = [];
  for (const item of Object.values(result.events?.dividends ?? {}) as { date?: number; amount?: number }[]) {
    if (typeof item?.date === "number" && typeof item?.amount === "number" && Number.isFinite(item.amount)) {
      dividends.push({
        time: item.date * 1000,
        date: formatDateInTz(item.date, timezone),
        amount: item.amount,
      });
    }
  }
  dividends.sort((a, b) => a.time - b.time);

  const splits: TickerSplit[] = [];
  for (const item of Object.values(result.events?.splits ?? {}) as {
    date?: number;
    numerator?: number;
    denominator?: number;
    splitRatio?: string;
  }[]) {
    if (
      typeof item?.date === "number" &&
      typeof item?.numerator === "number" &&
      typeof item?.denominator === "number" &&
      item.denominator > 0
    ) {
      splits.push({
        time: item.date * 1000,
        date: formatDateInTz(item.date, timezone),
        ratio: item.numerator / item.denominator,
        label: item.splitRatio || `${item.numerator}:${item.denominator}`,
      });
    }
  }
  splits.sort((a, b) => a.time - b.time);

  const chartData: TickerChartData = {
    symbol: String(meta.symbol || symbol),
    name: String(meta.shortName || meta.longName || meta.symbol || symbol),
    exchange: String(meta.fullExchangeName || meta.exchangeName || ""),
    instrumentType,
    currency,
    timezone,
    range,
    interval: config.interval,
    intraday: config.intraday,
    price: marketStatus.isExtendedHours && extended ? extended.price : regularPrice,
    previousClose,
    change: regularChange,
    changePct: regularChangePct,
    regularPrice,
    regularChange,
    regularChangePct,
    extended,
    stats: {
      open: finiteOrNull(meta.regularMarketOpen) ?? bars.find((b) => b.session === "regular")?.open ?? bars[0]?.open ?? null,
      dayHigh: finiteOrNull(meta.regularMarketDayHigh) ?? periodHigh?.price ?? null,
      dayLow: finiteOrNull(meta.regularMarketDayLow) ?? periodLow?.price ?? null,
      volume: finiteOrNull(meta.regularMarketVolume),
      fiftyTwoWeekHigh: finiteOrNull(meta.fiftyTwoWeekHigh),
      fiftyTwoWeekLow: finiteOrNull(meta.fiftyTwoWeekLow),
      periodOpen,
      periodClose,
      periodChange,
      periodChangePct,
      periodHigh,
      periodLow,
    },
    marketStatus,
    bars,
    dividends,
    splits,
  };

  const ttlMs = config.intraday ? 15_000 : 120_000;
  chartCache.set(cacheKey, { expiresAt: nowMs + ttlMs, value: chartData });
  if (chartCache.size > 200) {
    const oldestKey = chartCache.keys().next().value;
    if (oldestKey) chartCache.delete(oldestKey);
  }
  return chartData;
}

function downsampleSparkline(values: number[], target = 28): number[] {
  if (values.length <= target) return values;
  const out: number[] = [];
  const step = (values.length - 1) / (target - 1);
  for (let i = 0; i < target; i++) {
    out.push(values[Math.round(i * step)]);
  }
  return out;
}

export async function fetchTickerSnapshot(
  rawSymbol: string,
  request: typeof fetch = fetch,
  nowMs = Date.now(),
): Promise<TickerSnapshot> {
  const symbol = sanitizeSymbol(rawSymbol);
  if (!symbol) {
    return {
      symbol: rawSymbol,
      name: rawSymbol,
      exchange: "",
      currency: "USD",
      instrumentType: "EQUITY",
      price: null,
      previousClose: null,
      change: null,
      changePct: null,
      extended: null,
      marketStatus: null,
      sparkline: [],
      error: "Invalid symbol",
    };
  }

  const cached = snapshotCache.get(symbol);
  if (cached && cached.expiresAt > nowMs) return cached.value;

  try {
    const chart = await fetchTickerChart(symbol, "1d", request, nowMs);
    const regularBars = chart.bars.filter((b) => b.session === "regular");
    const sparkSource = (regularBars.length >= 2 ? regularBars : chart.bars).map((b) => b.close);
    const snapshot: TickerSnapshot = {
      symbol: chart.symbol,
      name: chart.name,
      exchange: chart.exchange,
      currency: chart.currency,
      instrumentType: chart.instrumentType,
      price: chart.regularPrice,
      previousClose: chart.previousClose,
      change: chart.regularChange,
      changePct: chart.regularChangePct,
      extended: chart.extended
        ? {
          session: chart.extended.session,
          price: chart.extended.price,
          changePct: chart.extended.changePct,
        }
        : null,
      marketStatus: chart.marketStatus,
      sparkline: downsampleSparkline(sparkSource),
    };
    snapshotCache.set(symbol, { expiresAt: nowMs + 20_000, value: snapshot });
    return snapshot;
  } catch (error) {
    return {
      symbol,
      name: symbol,
      exchange: "",
      currency: "USD",
      instrumentType: "EQUITY",
      price: null,
      previousClose: null,
      change: null,
      changePct: null,
      extended: null,
      marketStatus: null,
      sparkline: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function fetchTickerSnapshots(
  symbols: string[],
  request: typeof fetch = fetch,
  nowMs = Date.now(),
): Promise<TickerSnapshot[]> {
  const unique = [...new Set(symbols.map((s) => sanitizeSymbol(s)).filter((s): s is string => !!s))].slice(0, 40);
  const results = new Array<TickerSnapshot>(unique.length);
  const concurrency = 6;
  let nextIdx = 0;
  async function worker() {
    while (nextIdx < unique.length) {
      const idx = nextIdx++;
      results[idx] = await fetchTickerSnapshot(unique[idx], request, nowMs);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, unique.length) }, () => worker()));
  return results;
}
