import {
  BarSizeSetting,
  type Contract,
  type ContractDetails,
  EventName,
  type IBApi,
  SecType,
  WhatToShow,
} from "@stoqey/ib";
import type { Database } from "../database/setup.ts";
import { getUserIntegrations, type Integration } from "../database/integration.ts";
import { getIbkrHostPort, parseIbkrCredentials } from "../integrations/ibkr/credentials.ts";
import { isIbkrStatusMessage } from "../integrations/ibkr/connection.ts";
import { ibkrSessions } from "../integrations/ibkr/session.ts";
import { logFetch } from "../../utils/fetch_logging.ts";
import {
  type BarSession,
  computeMarketSession,
  type MarketStatus,
  type RawTradingPeriods,
  sanitizeSymbol,
  type TickerBar,
  type TickerChartData,
  type TickerKeyPoint,
  type TickerRange,
  type TickerSearchResult,
  type TickerSnapshot,
} from "./market.ts";

let nextReqId = 700_000;
function allocateReqId(): number {
  nextReqId = nextReqId >= 890_000 ? 700_000 : nextReqId + 1;
  return nextReqId;
}

const IB_TZ_MAP: Record<string, string> = {
  "US/Eastern": "America/New_York",
  "US/Central": "America/Chicago",
  "US/Mountain": "America/Denver",
  "US/Pacific": "America/Los_Angeles",
  "EST5EDT": "America/New_York",
  "CST6CDT": "America/Chicago",
  "PST8PDT": "America/Los_Angeles",
  "MET": "Europe/Berlin",
  "CET": "Europe/Berlin",
  "GB": "Europe/London",
  "GMT": "UTC",
};

export function normalizeIbTimezone(tz?: string): string {
  if (!tz) return "America/New_York";
  const trimmed = tz.trim();
  return IB_TZ_MAP[trimmed] ?? trimmed;
}

// Parse an IBKR local timestamp like "20261127:0930" in a given IANA timezone -> unix ms.
export function parseIbLocalDateTime(dateStr: string, hhmm: string, timezone: string): number | null {
  if (!/^\d{8}$/.test(dateStr) || !/^\d{4}$/.test(hhmm)) return null;
  const year = Number(dateStr.slice(0, 4));
  const month = Number(dateStr.slice(4, 6));
  const day = Number(dateStr.slice(6, 8));
  const hour = Number(hhmm.slice(0, 2));
  const minute = Number(hhmm.slice(2, 4));
  // Iterative offset convergence (2 passes handle DST transitions accurately).
  let utcGuess = Date.UTC(year, month - 1, day, hour, minute, 0);
  try {
    const fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
    for (let pass = 0; pass < 2; pass++) {
      const parts = fmt.formatToParts(new Date(utcGuess));
      const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
      const shownHour = get("hour") === 24 ? 0 : get("hour");
      const shownAsUtc = Date.UTC(get("year"), get("month") - 1, get("day"), shownHour, get("minute"), 0);
      const targetAsUtc = Date.UTC(year, month - 1, day, hour, minute, 0);
      utcGuess += targetAsUtc - shownAsUtc;
    }
    return utcGuess;
  } catch {
    return utcGuess;
  }
}

export type ParsedSessionWindow = { start: number; end: number }; // unix ms

export function parseIbHoursString(
  raw: string | undefined,
  timezone: string,
): ParsedSessionWindow[] {
  if (!raw) return [];
  const windows: ParsedSessionWindow[] = [];
  for (const segment of raw.split(";")) {
    const trimmed = segment.trim();
    if (!trimmed || trimmed.includes("CLOSED")) continue;
    const match = trimmed.match(/^(\d{8}):(\d{4})-(\d{8}):(\d{4})$/);
    if (!match) continue;
    const start = parseIbLocalDateTime(match[1], match[2], timezone);
    const end = parseIbLocalDateTime(match[3], match[4], timezone);
    if (start !== null && end !== null && end > start) {
      windows.push({ start, end });
    }
  }
  windows.sort((a, b) => a.start - b.start);
  return windows;
}

export function buildMarketStatusFromIbHours(params: {
  tradingHours?: string;
  liquidHours?: string;
  timeZoneId?: string;
  secType?: string;
  nowMs?: number;
}): { status: MarketStatus; regularWindows: ParsedSessionWindow[]; fullWindows: ParsedSessionWindow[] } {
  const nowMs = params.nowMs ?? Date.now();
  const timezone = normalizeIbTimezone(params.timeZoneId);
  const fullWindows = parseIbHoursString(params.tradingHours, timezone);
  const regularWindows = parseIbHoursString(params.liquidHours, timezone);
  const baseRegular = regularWindows.length ? regularWindows : fullWindows;

  // Pick the active or next upcoming full trading day first so after-hours
  // stays anchored to today's session even after regular hours have ended.
  const activeOrNext = (list: ParsedSessionWindow[]) =>
    list.find((w) => nowMs < w.end) ?? list.at(-1) ?? null;

  const fullToday = activeOrNext(fullWindows);
  const regToday = fullToday
    ? (baseRegular.find((r) => r.start >= fullToday.start && r.end <= fullToday.end) ??
      activeOrNext(baseRegular))
    : activeOrNext(baseRegular);

  const periods: RawTradingPeriods = {};
  if (regToday) {
    periods.regular = { start: regToday.start / 1000, end: regToday.end / 1000 };
    const matchingFull = fullToday && fullToday.start <= regToday.start && fullToday.end >= regToday.end
      ? fullToday
      : fullWindows.find((w) => w.start <= regToday.start && w.end >= regToday.end);
    if (matchingFull) {
      if (matchingFull.start < regToday.start) {
        periods.pre = { start: matchingFull.start / 1000, end: regToday.start / 1000 };
      }
      if (matchingFull.end > regToday.end) {
        periods.post = { start: regToday.end / 1000, end: matchingFull.end / 1000 };
      }
    }
  }

  const status = computeMarketSession({
    instrumentType: params.secType === "CRYPTO" ? "CRYPTOCURRENCY" : "EQUITY",
    timezone,
    currentTradingPeriod: periods,
    nowMs,
  });

  // Override nextRegularOpenAt with IBKR's exact holiday-aware next regular window when available.
  const nextReg = baseRegular.find((w) => w.start > nowMs);
  if (nextReg && status.state === "CLOSED") {
    status.nextRegularOpenAt = nextReg.start;
    status.nextTransitionAt = nextReg.start;
  }

  return { status, regularWindows: baseRegular, fullWindows };
}

function getUserIbkrIntegration(db: Database, userId: number): Integration | null {
  const integrations = getUserIntegrations(db, userId);
  return integrations.find((i) => i.kind === "ibkr") ?? null;
}

function ibkrConfigFor(integration: Integration) {
  const creds = parseIbkrCredentials(integration.credentials);
  const { host, port } = getIbkrHostPort(creds.instanceUrl);
  return {
    host,
    port,
    accountId: creds.accountId,
    clientId: creds.clientId,
    timeoutMs: Math.max(creds.timeoutMs, 6_000),
  };
}

const IB_RANGE_PARAMS: Record<
  TickerRange,
  { duration: string; barSize: BarSizeSetting; intraday: boolean; useRTH: number }
> = {
  "1d": { duration: "1 D", barSize: BarSizeSetting.MINUTES_FIVE, intraday: true, useRTH: 0 },
  "5d": { duration: "5 D", barSize: BarSizeSetting.MINUTES_FIFTEEN, intraday: true, useRTH: 0 },
  "1m": { duration: "1 M", barSize: BarSizeSetting.DAYS_ONE, intraday: false, useRTH: 1 },
  "3m": { duration: "3 M", barSize: BarSizeSetting.DAYS_ONE, intraday: false, useRTH: 1 },
  "6m": { duration: "6 M", barSize: BarSizeSetting.DAYS_ONE, intraday: false, useRTH: 1 },
  "ytd": { duration: "1 Y", barSize: BarSizeSetting.DAYS_ONE, intraday: false, useRTH: 1 },
  "1y": { duration: "1 Y", barSize: BarSizeSetting.DAYS_ONE, intraday: false, useRTH: 1 },
  "5y": { duration: "5 Y", barSize: BarSizeSetting.WEEKS_ONE, intraday: false, useRTH: 1 },
  "max": { duration: "20 Y", barSize: BarSizeSetting.MONTHS_ONE, intraday: false, useRTH: 1 },
};

type CachedEntry<T> = { expiresAt: number; value: T };
const ibSearchCache = new Map<string, CachedEntry<TickerSearchResult[]>>();
const ibChartCache = new Map<string, CachedEntry<TickerChartData>>();
const ibContractCache = new Map<string, CachedEntry<ContractDetails>>();
const ibSnapCache = new Map<string, CachedEntry<TickerSnapshot>>();

function parseSymbolInput(raw: string): { symbol: string; conId?: number; exchange?: string; currency?: string } {
  const cleaned = sanitizeSymbol(raw);
  if (!cleaned) throw new Error("Invalid ticker symbol.");
  // Support explicit conId syntax "conId:4815747" if passed from search
  const conMatch = cleaned.match(/^CONID:(\d+)$/);
  if (conMatch) {
    return { symbol: cleaned, conId: Number(conMatch[1]) };
  }
  // Common Yahoo-style European suffixes -> IBKR base symbol + currency hint
  if (cleaned.endsWith(".L")) return { symbol: cleaned.slice(0, -2), exchange: "LSEETF" };
  if (cleaned.endsWith(".DE") || cleaned.endsWith(".F")) {
    return { symbol: cleaned.slice(0, cleaned.lastIndexOf(".")), currency: "EUR" };
  }
  if (cleaned.endsWith(".AS")) return { symbol: cleaned.slice(0, -3), currency: "EUR" };
  if (cleaned.endsWith(".SW")) return { symbol: cleaned.slice(0, -3), currency: "CHF" };
  return { symbol: cleaned };
}

async function runWithIbkr<T>(
  integration: Integration,
  operation: string,
  action: (api: IBApi) => Promise<T>,
): Promise<T> {
  const config = ibkrConfigFor(integration);
  return await logFetch(`IBKR Web ${operation}`, () => ibkrSessions.run(config, action));
}

function reqMatchingSymbolsOnce(
  api: IBApi,
  pattern: string,
  timeoutMs = 5_000,
): Promise<{ conId?: number; symbol: string; secType: string; primaryExch: string; currency: string; description: string }[]> {
  const reqId = allocateReqId();
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (
      err?: Error,
      list?: { conId?: number; symbol: string; secType: string; primaryExch: string; currency: string; description: string }[],
    ) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      api.off(EventName.symbolSamples, onSamples);
      api.off(EventName.error, onError);
      if (err) reject(err);
      else resolve(list ?? []);
    };
    const onSamples = (id: number, descriptions: { contract?: Contract }[]) => {
      if (id !== reqId) return;
      const out = (descriptions ?? [])
        .filter((d) => d?.contract?.symbol)
        .map((d) => ({
          conId: d.contract!.conId,
          symbol: String(d.contract!.symbol),
          secType: String(d.contract!.secType || "STK"),
          primaryExch: String(d.contract!.primaryExch || d.contract!.exchange || ""),
          currency: String(d.contract!.currency || "USD"),
          description: String(d.contract!.description || d.contract!.symbol),
        }));
      finish(undefined, out);
    };
    const onError = (error: Error, code: number, id: number) => {
      if (id === reqId && !isIbkrStatusMessage(code)) {
        finish(new Error(error?.message || `IBKR symbol search error (${code})`));
      }
    };
    const timer = setTimeout(() => finish(new Error("IBKR symbol search timed out.")), timeoutMs);
    api.on(EventName.symbolSamples, onSamples);
    api.on(EventName.error, onError);
    api.reqMatchingSymbols(reqId, pattern);
  });
}

function reqContractDetailsOnce(
  api: IBApi,
  contract: Contract,
  timeoutMs = 5_000,
): Promise<ContractDetails[]> {
  const reqId = allocateReqId();
  return new Promise((resolve, reject) => {
    let done = false;
    const rows: ContractDetails[] = [];
    const finish = (err?: Error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      api.off(EventName.contractDetails, onDetails);
      api.off(EventName.contractDetailsEnd, onEnd);
      api.off(EventName.error, onError);
      if (err) reject(err);
      else resolve(rows);
    };
    const onDetails = (id: number, details: ContractDetails) => {
      if (id === reqId) rows.push(details);
    };
    const onEnd = (id: number) => {
      if (id === reqId) finish();
    };
    const onError = (error: Error, code: number, id: number) => {
      if (id === reqId && !isIbkrStatusMessage(code)) {
        finish(new Error(error?.message || `IBKR contract details error (${code})`));
      }
    };
    const timer = setTimeout(() => finish(rows.length ? undefined : new Error("IBKR contract details timed out.")), timeoutMs);
    api.on(EventName.contractDetails, onDetails);
    api.on(EventName.contractDetailsEnd, onEnd);
    api.on(EventName.error, onError);
    api.reqContractDetails(reqId, contract);
  });
}

async function resolveIbContractDetails(
  api: IBApi,
  rawSymbol: string,
  nowMs = Date.now(),
): Promise<ContractDetails> {
  const cacheKey = rawSymbol.trim().toUpperCase();
  const cached = ibContractCache.get(cacheKey);
  if (cached && cached.expiresAt > nowMs) return cached.value;

  const parsed = parseSymbolInput(rawSymbol);
  let found: ContractDetails | undefined;

  if (parsed.conId) {
    const list = await reqContractDetailsOnce(api, { conId: parsed.conId, exchange: "SMART" });
    found = list[0];
  } else {
    // Try direct SMART USD stock lookup first (fast path for US equities).
    if (!parsed.exchange && !parsed.currency) {
      try {
        const list = await reqContractDetailsOnce(api, {
          symbol: parsed.symbol,
          secType: SecType.STK,
          exchange: "SMART",
          currency: "USD",
        });
        found = list[0];
      } catch {
        // Fall through to reqMatchingSymbols for non-US / ETF / FX / index symbols.
      }
    }
    if (!found) {
      const samples = await reqMatchingSymbolsOnce(api, parsed.symbol);
      const exact = samples.find((s) =>
        s.symbol.toUpperCase() === parsed.symbol.toUpperCase() &&
        (!parsed.currency || s.currency.toUpperCase() === parsed.currency) &&
        (!parsed.exchange || s.primaryExch.toUpperCase().includes(parsed.exchange))
      ) ?? samples.find((s) => s.symbol.toUpperCase() === parsed.symbol.toUpperCase()) ?? samples[0];
      if (!exact?.conId) {
        throw new Error(`IBKR could not resolve contract for "${rawSymbol}".`);
      }
      const list = await reqContractDetailsOnce(api, {
        conId: exact.conId,
        exchange: exact.secType === "STK" ? "SMART" : exact.primaryExch || "SMART",
      });
      found = list[0];
    }
  }

  if (!found?.contract?.conId) {
    throw new Error(`IBKR returned no contract details for "${rawSymbol}".`);
  }
  ibContractCache.set(cacheKey, { expiresAt: nowMs + 10 * 60_000, value: found });
  return found;
}

type RawIbBar = {
  time: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

function reqHistoricalBarsOnce(
  api: IBApi,
  contract: Contract,
  duration: string,
  barSize: BarSizeSetting,
  whatToShow: WhatToShow,
  useRTH: number,
  formatDate: 1 | 2,
  timeoutMs = 8_000,
): Promise<RawIbBar[]> {
  const reqId = allocateReqId();
  return new Promise((resolve, reject) => {
    let done = false;
    const bars: RawIbBar[] = [];
    const finish = (err?: Error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      api.off(EventName.historicalData, onBar);
      api.off(EventName.error, onError);
      if (err) {
        try { api.cancelHistoricalData(reqId); } catch { /* ignore */ }
        reject(err);
      } else {
        resolve(bars);
      }
    };
    const onBar = (
      id: number,
      time: string,
      open: number,
      high: number,
      low: number,
      close: number,
      volume: number,
    ) => {
      if (id !== reqId) return;
      if (typeof time === "string" && time.startsWith("finished")) {
        finish();
        return;
      }
      if (Number.isFinite(close) && close > 0) {
        bars.push({
          time: String(time),
          open: Number.isFinite(open) && open > 0 ? open : close,
          high: Number.isFinite(high) && high > 0 ? high : close,
          low: Number.isFinite(low) && low > 0 ? low : close,
          close,
          volume: Number.isFinite(volume) && volume >= 0 ? volume : -1,
        });
      }
    };
    const onError = (error: Error, code: number, id: number) => {
      if (id === reqId && !isIbkrStatusMessage(code)) {
        finish(new Error(error?.message || `IBKR historical data error (${code})`));
      }
    };
    const timer = setTimeout(() => finish(new Error("IBKR historical data timed out.")), timeoutMs);
    api.on(EventName.historicalData, onBar);
    api.on(EventName.error, onError);
    api.reqHistoricalData(
      reqId,
      contract,
      "",
      duration,
      barSize,
      whatToShow,
      useRTH,
      formatDate,
      false,
    );
  });
}

type IbQuoteTicks = {
  last: number | null;
  close: number | null;
  open: number | null;
  high: number | null;
  low: number | null;
  delayed: boolean;
};

function reqQuoteSnapshotOnce(
  api: IBApi,
  contract: Contract,
  timeoutMs = 2_500,
): Promise<IbQuoteTicks> {
  const reqId = allocateReqId();
  return new Promise((resolve) => {
    let done = false;
    const ticks = new Map<number, number>();
    let delayed = true;
    let settleTimer: ReturnType<typeof setTimeout> | undefined;

    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      clearTimeout(settleTimer);
      api.off(EventName.tickPrice, onPrice);
      api.off(EventName.marketDataType, onType);
      api.off(EventName.error, onError);
      try { api.cancelMktData(reqId); } catch { /* ignore */ }
      resolve({
        last: ticks.get(4) ?? ticks.get(68) ?? null,
        close: ticks.get(9) ?? ticks.get(75) ?? null,
        open: ticks.get(14) ?? ticks.get(76) ?? null,
        high: ticks.get(6) ?? ticks.get(72) ?? null,
        low: ticks.get(7) ?? ticks.get(73) ?? null,
        delayed,
      });
    };

    const maybeSettle = () => {
      const hasLast = ticks.has(4) || ticks.has(68);
      const hasClose = ticks.has(9) || ticks.has(75);
      if (hasLast && hasClose && settleTimer === undefined) {
        settleTimer = setTimeout(finish, 180);
      }
    };

    const onPrice = (id: number, tickType: number, price: number) => {
      if (id !== reqId) return;
      if (Number.isFinite(price) && price > 0 && price < Number.MAX_VALUE) {
        ticks.set(tickType, price);
        maybeSettle();
      }
    };
    const onType = (id: number, dataType: number) => {
      if (id === reqId) delayed = dataType === 3 || dataType === 4;
    };
    const onError = (_err: Error, code: number, id: number) => {
      if (id === reqId && !isIbkrStatusMessage(code) && code !== 10167) {
        finish();
      }
    };

    const timer = setTimeout(finish, timeoutMs);
    api.on(EventName.tickPrice, onPrice);
    api.on(EventName.marketDataType, onType);
    api.on(EventName.error, onError);
    api.reqMarketDataType(4);
    api.reqMktData(reqId, contract, "", false, false);
  });
}

function formatDateInTz(ms: number, timezone: string): string {
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date(ms));
  } catch {
    return new Date(ms).toISOString().slice(0, 10);
  }
}

function classifyIbBarSession(
  ms: number,
  intraday: boolean,
  regularWindows: ParsedSessionWindow[],
): BarSession {
  if (!intraday || !regularWindows.length) return "regular";
  for (const w of regularWindows) {
    if (ms >= w.start && ms < w.end) return "regular";
  }
  // Compare against closest regular window within 14 hours.
  let closest: ParsedSessionWindow | null = null;
  let bestDist = Infinity;
  for (const w of regularWindows) {
    const dist = Math.min(Math.abs(ms - w.start), Math.abs(ms - w.end));
    if (dist < bestDist) {
      bestDist = dist;
      closest = w;
    }
  }
  if (closest && bestDist < 14 * 3600_000) {
    return ms < closest.start ? "pre" : "post";
  }
  return "regular";
}

export function hasUserIbkrIntegration(db: Database, userId: number): boolean {
  return getUserIbkrIntegration(db, userId) !== null;
}

export async function searchTickersViaIbkr(
  db: Database,
  userId: number,
  query: string,
  nowMs = Date.now(),
): Promise<TickerSearchResult[] | null> {
  const integration = getUserIbkrIntegration(db, userId);
  if (!integration) return null;
  const trimmed = query.trim();
  if (!trimmed) return [];
  const cacheKey = `${integration.id}:${trimmed.toUpperCase()}`;
  const cached = ibSearchCache.get(cacheKey);
  if (cached && cached.expiresAt > nowMs) return cached.value;

  const samples = await runWithIbkr(
    integration,
    `search ${trimmed}`,
    (api) => reqMatchingSymbolsOnce(api, trimmed),
  );
  const results: TickerSearchResult[] = samples.slice(0, 12).map((s) => ({
    symbol: s.currency === "USD" && ["NASDAQ", "NYSE", "ARCA", "BATS", "AMEX"].includes(s.primaryExch)
      ? s.symbol
      : s.conId
      ? `${s.symbol}`
      : s.symbol,
    name: `${s.description}${s.currency && s.currency !== "USD" ? ` (${s.currency})` : ""}`,
    exchange: s.primaryExch || "IBKR",
    quoteType: s.secType,
  }));
  // Deduplicate by symbol + exchange
  const seen = new Set<string>();
  const deduped = results.filter((r) => {
    const key = `${r.symbol}:${r.exchange}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  ibSearchCache.set(cacheKey, { expiresAt: nowMs + 60_000, value: deduped });
  return deduped;
}

export async function fetchTickerChartViaIbkr(
  db: Database,
  userId: number,
  rawSymbol: string,
  range: TickerRange = "1d",
  nowMs = Date.now(),
): Promise<(TickerChartData & { source: "ibkr"; delayed?: boolean }) | null> {
  const integration = getUserIbkrIntegration(db, userId);
  if (!integration) return null;
  const symbolKey = sanitizeSymbol(rawSymbol);
  if (!symbolKey) throw new Error("Invalid ticker symbol.");

  const cacheKey = `${integration.id}:${symbolKey}:${range}`;
  const cached = ibChartCache.get(cacheKey);
  if (cached && cached.expiresAt > nowMs) {
    return { ...cached.value, source: "ibkr" };
  }

  const cfg = IB_RANGE_PARAMS[range];

  const chart = await runWithIbkr(integration, `chart ${symbolKey} ${range}`, async (api) => {
    const details = await resolveIbContractDetails(api, symbolKey, nowMs);
    const contract: Contract = {
      conId: details.contract.conId,
      symbol: details.contract.symbol,
      secType: details.contract.secType,
      exchange: details.contract.secType === SecType.STK ? "SMART" : (details.contract.exchange || "SMART"),
      currency: details.contract.currency,
    };

    const { status: marketStatus, regularWindows } = buildMarketStatusFromIbHours({
      tradingHours: details.tradingHours,
      liquidHours: details.liquidHours,
      timeZoneId: details.timeZoneId,
      secType: details.contract.secType,
      nowMs,
    });
    const timezone = marketStatus.timezone;

    const whatToShow = details.contract.secType === SecType.CASH
      ? WhatToShow.MIDPOINT
      : WhatToShow.TRADES;

    const [rawBars, quote] = await Promise.all([
      reqHistoricalBarsOnce(
        api,
        contract,
        cfg.duration,
        cfg.barSize,
        whatToShow,
        cfg.useRTH,
        cfg.intraday ? 2 : 1,
      ),
      reqQuoteSnapshotOnce(api, contract).catch(() => ({
        last: null,
        close: null,
        open: null,
        high: null,
        low: null,
        delayed: true,
      })),
    ]);

    const ytdStart = `${new Date(nowMs).getUTCFullYear()}-01-01`;
    const bars: TickerBar[] = [];
    for (const b of rawBars) {
      let timeMs: number;
      let dateStr: string;
      if (cfg.intraday && /^\d+$/.test(b.time)) {
        timeMs = Number(b.time) * 1000;
        dateStr = formatDateInTz(timeMs, timezone);
      } else if (/^\d{8}$/.test(b.time)) {
        dateStr = `${b.time.slice(0, 4)}-${b.time.slice(4, 6)}-${b.time.slice(6, 8)}`;
        timeMs = Date.parse(`${dateStr}T16:00:00Z`);
      } else {
        const parsed = Date.parse(b.time);
        if (!Number.isFinite(parsed)) continue;
        timeMs = parsed;
        dateStr = formatDateInTz(timeMs, timezone);
      }
      if (range === "ytd" && dateStr < ytdStart) continue;
      bars.push({
        time: timeMs,
        date: dateStr,
        open: b.open,
        high: b.high,
        low: b.low,
        close: b.close,
        volume: b.volume >= 0 ? b.volume : null,
        session: classifyIbBarSession(timeMs, cfg.intraday, regularWindows),
      });
    }

    const regularBars = bars.filter((b) => b.session === "regular");
    const regularPrice = quote.last ?? regularBars.at(-1)?.close ?? bars.at(-1)?.close ?? 0;
    const previousClose = quote.close ?? (bars.length >= 2 ? bars[bars.length - 2].close : null);
    const regularChange = previousClose !== null && previousClose !== 0 ? regularPrice - previousClose : null;
    const regularChangePct = previousClose !== null && previousClose !== 0 && regularChange !== null
      ? (regularChange / previousClose) * 100
      : null;

    let extended: TickerChartData["extended"] = null;
    if (cfg.intraday && bars.length) {
      const lastBar = bars[bars.length - 1];
      if (lastBar.session !== "regular") {
        const ref = lastBar.session === "post" ? regularPrice : (previousClose ?? regularPrice);
        const chg = lastBar.close - ref;
        extended = {
          session: lastBar.session,
          price: lastBar.close,
          change: chg,
          changePct: ref !== 0 ? (chg / ref) * 100 : null,
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

    const periodOpen = range === "1d" && previousClose !== null ? previousClose : (bars[0]?.open ?? null);
    const periodClose = bars.at(-1)?.close ?? regularPrice;
    const periodChange = periodOpen !== null ? periodClose - periodOpen : null;
    const periodChangePct = periodOpen !== null && periodOpen !== 0 && periodChange !== null
      ? (periodChange / periodOpen) * 100
      : null;

    const exchangeParts = [details.contract.primaryExch || details.contract.exchange, "IBKR"];
    if (quote.delayed) exchangeParts.push("Delayed");

    const data: TickerChartData = {
      symbol: String(details.contract.symbol || symbolKey),
      name: String(details.longName || details.contract.symbol || symbolKey),
      exchange: exchangeParts.filter(Boolean).join(" · "),
      instrumentType: String(details.contract.secType || "STK"),
      currency: String(details.contract.currency || "USD"),
      timezone,
      range,
      interval: String(cfg.barSize),
      intraday: cfg.intraday,
      price: marketStatus.isExtendedHours && extended ? extended.price : regularPrice,
      previousClose,
      change: regularChange,
      changePct: regularChangePct,
      regularPrice,
      regularChange,
      regularChangePct,
      extended,
      stats: {
        open: quote.open ?? regularBars[0]?.open ?? bars[0]?.open ?? null,
        dayHigh: quote.high ?? periodHigh?.price ?? null,
        dayLow: quote.low ?? periodLow?.price ?? null,
        volume: bars.reduce((sum, b) => sum + (b.volume ?? 0), 0) || null,
        fiftyTwoWeekHigh: null,
        fiftyTwoWeekLow: null,
        periodOpen,
        periodClose,
        periodChange,
        periodChangePct,
        periodHigh,
        periodLow,
      },
      marketStatus,
      bars,
      dividends: [],
      splits: [],
    };
    return { data, delayed: quote.delayed };
  });

  const ttlMs = cfg.intraday ? 20_000 : 120_000;
  ibChartCache.set(cacheKey, { expiresAt: nowMs + ttlMs, value: chart.data });
  return { ...chart.data, source: "ibkr", delayed: chart.delayed };
}

export async function fetchTickerSnapshotsViaIbkr(
  db: Database,
  userId: number,
  rawSymbols: string[],
  nowMs = Date.now(),
): Promise<Map<string, TickerSnapshot> | null> {
  const integration = getUserIbkrIntegration(db, userId);
  if (!integration) return null;
  const symbols = [...new Set(rawSymbols.map((s) => sanitizeSymbol(s)).filter((s): s is string => !!s))].slice(0, 30);
  if (!symbols.length) return new Map();

  const out = new Map<string, TickerSnapshot>();
  const missing: string[] = [];
  for (const sym of symbols) {
    const cached = ibSnapCache.get(`${integration.id}:${sym}`);
    if (cached && cached.expiresAt > nowMs) {
      out.set(sym, cached.value);
    } else {
      missing.push(sym);
    }
  }
  if (!missing.length) return out;

  // Batch all quotes on ONE IBKR session via reqMktData (avoids reqHistoricalData pacing).
  const fetched = await runWithIbkr(
    integration,
    `snapshots ${missing.join(",")}`,
    async (api) => {
      const results = new Map<string, TickerSnapshot>();
      api.reqMarketDataType(4);

      for (let offset = 0; offset < missing.length; offset += 20) {
        const batch = missing.slice(offset, offset + 20);
        const reqToSym = new Map<number, string>();
        const ticksByReq = new Map<number, Map<number, number>>();
        const errored = new Set<number>();

        let finishBatch!: () => void;
        let settleTimer: ReturnType<typeof setTimeout> | undefined;
        let batchTimer: ReturnType<typeof setTimeout> | undefined;

        const checkDone = () => {
          const allReady = [...reqToSym.keys()].every((id) => {
            if (errored.has(id)) return true;
            const t = ticksByReq.get(id);
            const hasLast = t?.has(4) || t?.has(68);
            const hasClose = t?.has(9) || t?.has(75);
            return Boolean(hasLast && hasClose);
          });
          if (allReady && settleTimer === undefined) {
            settleTimer = setTimeout(finishBatch, 180);
          }
        };

        const onPrice = (id: number, type: number, price: number) => {
          if (!reqToSym.has(id)) return;
          if (Number.isFinite(price) && price > 0 && price < Number.MAX_VALUE) {
            ticksByReq.get(id)?.set(type, price);
            checkDone();
          }
        };
        const onError = (_err: Error, code: number, id: number) => {
          if (!reqToSym.has(id) || isIbkrStatusMessage(code) || code === 10167) return;
          errored.add(id);
          checkDone();
        };

        const ready = new Promise<void>((resolve) => {
          finishBatch = resolve;
          batchTimer = setTimeout(resolve, 2_500);
        });

        api.on(EventName.tickPrice, onPrice);
        api.on(EventName.error, onError);
        try {
          for (const sym of batch) {
            const reqId = allocateReqId();
            const parsed = parseSymbolInput(sym);
            reqToSym.set(reqId, sym);
            ticksByReq.set(reqId, new Map());
            api.reqMktData(
              reqId,
              {
                ...(parsed.conId ? { conId: parsed.conId } : { symbol: parsed.symbol, secType: SecType.STK }),
                exchange: "SMART",
                currency: parsed.currency ?? "USD",
              },
              "",
              false,
              false,
            );
          }
          await ready;
        } finally {
          clearTimeout(batchTimer);
          clearTimeout(settleTimer);
          api.off(EventName.tickPrice, onPrice);
          api.off(EventName.error, onError);
          for (const reqId of reqToSym.keys()) {
            try { api.cancelMktData(reqId); } catch { /* ignore */ }
          }
        }

        for (const [reqId, sym] of reqToSym) {
          const t = ticksByReq.get(reqId);
          const last = t?.get(4) ?? t?.get(68) ?? null;
          const prevClose = t?.get(9) ?? t?.get(75) ?? null;
          const price = last ?? prevClose;
          if (price === null) continue;
          const change = prevClose !== null && prevClose !== 0 ? price - prevClose : null;
          const changePct = prevClose !== null && prevClose !== 0 && change !== null
            ? (change / prevClose) * 100
            : null;
          const snap: TickerSnapshot = {
            symbol: sym,
            name: sym,
            exchange: "IBKR",
            currency: parseSymbolInput(sym).currency ?? "USD",
            instrumentType: "STK",
            price,
            previousClose: prevClose,
            change,
            changePct,
            extended: null,
            marketStatus: null,
            sparkline: [],
          };
          results.set(sym, snap);
        }
      }
      return results;
    },
  );

  for (const [sym, snap] of fetched) {
    ibSnapCache.set(`${integration.id}:${sym}`, { expiresAt: nowMs + 25_000, value: snap });
    out.set(sym, snap);
  }
  return out;
}
