import type { Database } from "../database/setup.ts";
import { logFetch } from "../../utils/fetch_logging.ts";
import { defaultYahooSymbols, likelyYahooSymbols } from "./symbols.ts";
import { readYahooMapping } from "./mappings.ts";
import { yahooOptionContract } from "./options.ts";
import { DATABENTO_PREFIX, DatabentoHistoryCache } from "./databento.ts";

import {
  dayAfter,
  missingRanges,
  type PriceBar,
  type PriceHistory,
  type Range,
  type StockSplit,
} from "./history.ts";
export {
  dayAfter,
  missingRanges,
  type PriceBar,
  type PriceHistory,
  type StockSplit,
} from "./history.ts";
export type HistoricalInstrument = {
  ticker: string;
  currency: string;
  yahooSymbol?: string;
  isin?: string;
};
const headers = {
  "User-Agent": "Mozilla/5.0 Eyri/1.0",
  Accept: "application/json",
};
export const quoteCurrency = (currency: string) =>
  currency === "GBp" ? "GBX" : currency.toUpperCase();

export function ensureMarketDataSchema(db: Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS yahoo_symbols (source_key TEXT PRIMARY KEY, symbol TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS yahoo_prices (symbol TEXT NOT NULL, date TEXT NOT NULL, close REAL NOT NULL, currency TEXT NOT NULL, PRIMARY KEY(symbol,date));
    CREATE TABLE IF NOT EXISTS yahoo_splits (symbol TEXT NOT NULL, date TEXT NOT NULL, ratio REAL NOT NULL, PRIMARY KEY(symbol,date));
    CREATE TABLE IF NOT EXISTS yahoo_coverage (symbol TEXT NOT NULL, start TEXT NOT NULL, end TEXT NOT NULL, PRIMARY KEY(symbol,start,end));
    CREATE TABLE IF NOT EXISTS yahoo_recent (symbol TEXT PRIMARY KEY, fetched_at REAL NOT NULL, payload TEXT NOT NULL);
  `);
}

async function jsonRequest(
  url: string,
  request: typeof fetch,
  operation = new URL(url).pathname,
) {
  return logFetch(`Yahoo ${operation}`, async () => {
    const response = await request(url, {
      headers,
      redirect: "error",
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`Yahoo Finance returned HTTP ${response.status}.`);
    }
    return await response.json();
  }, (data) => data?.chart?.result?.[0]?.timestamp?.length ?? data?.quotes?.length);
}

function tradingDate(timestamp: number, timezone: string) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(timestamp * 1000));
}

export async function fetchYahooHistory(
  symbol: string,
  start: string,
  end: string,
  request: typeof fetch = fetch,
): Promise<PriceHistory> {
  const url = new URL(
    `https://query1.finance.yahoo.com/v8/finance/chart/${
      encodeURIComponent(symbol)
    }`,
  );
  url.searchParams.set("period1", String(Date.parse(start) / 1000));
  url.searchParams.set("period2", String(Date.parse(end) / 1000));
  url.searchParams.set("interval", "1d");
  url.searchParams.set("events", "splits");
  const data = await jsonRequest(
    String(url), request, `history ${symbol} ${start}..${end}`,
  );
  const result = data?.chart?.result?.[0];
  if (
    data?.chart?.error || !result?.meta?.currency ||
    !result.meta.exchangeTimezoneName
  ) throw new Error(`Historical prices unavailable for ${symbol}.`);
  const timezone = result.meta.exchangeTimezoneName;
  const timestamps = result.timestamp ?? [];
  const closes = result.indicators?.quote?.[0]?.close ?? [];
  if (
    !Array.isArray(timestamps) || !Array.isArray(closes) ||
    timestamps.length !== closes.length
  ) throw new Error(`Invalid historical prices for ${symbol}.`);
  const bars: PriceBar[] = [];
  for (let i = 0; i < timestamps.length; i++) {
    if (closes[i] === null) continue;
    if (
      !Number.isFinite(timestamps[i]) || typeof closes[i] !== "number" ||
      !Number.isFinite(closes[i]) || closes[i] < 0 ||
      (closes[i] === 0 && result.meta.instrumentType !== "OPTION")
    ) throw new Error(`Invalid historical price for ${symbol}.`);
    const date = tradingDate(timestamps[i], timezone);
    if (date >= start && date < end) bars.push({ date, close: closes[i] });
  }
  const splits: StockSplit[] = [];
  for (
    const event of Object.values(result.events?.splits ?? {}) as {
      date: number;
      numerator: number;
      denominator: number;
    }[]
  ) {
    const ratio = event.numerator / event.denominator;
    if (!Number.isFinite(event.date) || !Number.isFinite(ratio) || ratio <= 0) {
      throw new Error(`Invalid stock split for ${symbol}.`);
    }
    splits.push({ date: tradingDate(event.date, timezone), ratio });
  }
  return {
    symbol,
    currency: quoteCurrency(result.meta.currency),
    bars,
    splits,
    instrumentType: result.meta.instrumentType,
  };
}

export class YahooHistoryCache {
  private pending = new Map<string, Promise<PriceHistory>>();
  private queues = new Map<string, Promise<unknown>>();
  constructor(
    private db: Database,
    private request: typeof fetch = fetch,
    private now: () => Date = () => new Date(),
    private optionHistory = new DatabentoHistoryCache(db, request, now),
  ) {
    ensureMarketDataSchema(db);
  }

  async resolve(
    instrument: HistoricalInstrument,
    requiredDate?: string,
    userId?: number,
    requiredEnd?: string,
  ): Promise<string> {
    const sourceOption = yahooOptionContract(instrument.ticker);
    const userMapping = userId === undefined
      ? undefined
      : readYahooMapping(this.db, userId, instrument.ticker);
    const configured = JSON.parse(Deno.env.get("EYRI_YAHOO_SYMBOLS") ?? "{}");
    const overrideKey =
      `${instrument.ticker.trim().toUpperCase()}:${instrument.currency.trim().toUpperCase()}`;
    const override = configured[overrideKey];
    if (
      !userMapping && override !== undefined &&
      (typeof override !== "string" || !override.trim())
    ) {
      throw new Error(
        `Invalid EYRI_YAHOO_SYMBOLS override for ${overrideKey}.`,
      );
    }
    const explicit = userMapping ??
      (typeof override === "string"
        ? override.trim().toUpperCase()
        : undefined);
    const sourceKey = JSON.stringify([
      instrument.ticker.toUpperCase(),
      instrument.currency.toUpperCase(),
      instrument.isin ?? "",
      instrument.yahooSymbol ?? "",
      // A user's mapping must not change another user's cached resolution.
      ...(userMapping
        ? ["user", String(userId), userMapping]
        : explicit
        ? ["configured", explicit]
        : []),
    ]);
    const cached = this.db.prepare(
      "SELECT symbol FROM yahoo_symbols WHERE source_key = ?",
    ).get(sourceKey) as { symbol: string } | undefined;
    const coversPurchase = async (symbol: string) => {
      if (!requiredDate) return true;
      const history = await this.get(
        symbol,
        dayAfter(requiredDate, -7),
        requiredEnd,
      );
      return history.bars.some((bar) => bar.date <= requiredDate!);
    };
    if (
      cached &&
      (sourceOption ||
        (!cached.symbol.startsWith(DATABENTO_PREFIX) &&
          !yahooOptionContract(cached.symbol))) &&
      (!explicit || cached.symbol === explicit ||
        cached.symbol === DATABENTO_PREFIX + explicit)
    ) {
      try {
        if (await coversPurchase(cached.symbol)) return cached.symbol;
      } catch {
        // A stale/unavailable cached listing can still have a usable alternate.
      }
    }
    const candidates = explicit ? [explicit] : defaultYahooSymbols(instrument);
    const today = this.now().toISOString().slice(0, 10);
    const attempted = new Set<string>();
    const accept = async (symbol: string, fromIsin = false) => {
      const attemptKey = `${fromIsin ? "isin" : "symbol"}:${symbol}`;
      if (attempted.has(attemptKey)) return false;
      attempted.add(attemptKey);
      try {
        const option = yahooOptionContract(symbol);
        if (option && !sourceOption) return false;
        const expired = option && option.expiry < today;
        const history = expired
          ? await this.get(
            symbol,
            requiredDate ? dayAfter(requiredDate, -7) : "1970-01-01",
            requiredEnd,
          )
          : await fetchYahooHistory(
            symbol,
            dayAfter(today, -7),
            dayAfter(today),
            this.request,
          );
        if (sourceOption && history.instrumentType !== "OPTION") return false;
        if (!requiredDate && !history.bars.length) return false;
        const currency = instrument.currency.trim().toUpperCase();
        if (
          !fromIsin && !explicit && history.currency !== currency &&
          !(new Set([history.currency, currency]).size === 2 &&
            [history.currency, currency].every((c) =>
              c === "GBP" || c === "GBX"
            ))
        ) return false;
        // Resolution data also serves the initial recent-price request.
        if (!expired && !history.symbol.startsWith(DATABENTO_PREFIX)) {
          this.db.prepare(
            "INSERT OR REPLACE INTO yahoo_recent(symbol,fetched_at,payload) VALUES (?,?,?)",
          ).run(symbol, +this.now(), JSON.stringify(history));
        }
        if (!await coversPurchase(symbol)) return false;
        this.db.prepare(
          "INSERT OR REPLACE INTO yahoo_symbols(source_key,symbol) VALUES (?,?)",
        ).run(sourceKey, symbol);
        return true;
      } catch {
        return false;
      }
    };
    for (const candidate of [...new Set(candidates)]) {
      if (await accept(candidate)) return candidate;
    }
    if (!explicit && instrument.isin) {
      const search = new URL(
        "https://query1.finance.yahoo.com/v1/finance/search",
      );
      search.searchParams.set("q", instrument.isin);
      search.searchParams.set("quotesCount", "5");
      search.searchParams.set("newsCount", "0");
      try {
        const data = await jsonRequest(String(search), this.request);
        for (const item of data.quotes ?? []) {
          if (
            typeof item.symbol === "string" &&
            (item.quoteType === "EQUITY" || item.quoteType === "ETF") &&
            await accept(item.symbol, true)
          ) return item.symbol;
        }
      } catch {
        // Search availability must not prevent trying the bounded chart candidates.
      }
    }
    if (!explicit) {
      for (const candidate of likelyYahooSymbols(instrument)) {
        if (await accept(candidate)) return candidate;
      }
    }
    // Only recognized option contracts may reach the paid archive. An explicit
    // stock mapping must still fail instead of silently replacing that mapping.
    const fallbackOption = sourceOption &&
      (explicit ? yahooOptionContract(explicit) : sourceOption);
    if (
      fallbackOption &&
      (this.optionHistory.configured ||
        this.optionHistory.has(fallbackOption.symbol))
    ) {
      const history = await this.optionHistory.get(
        fallbackOption.symbol,
        requiredDate ? dayAfter(requiredDate, -7) : "2013-04-01",
        requiredEnd,
      );
      if (
        history.bars.length &&
        (!requiredDate || history.bars.some((bar) => bar.date <= requiredDate))
      ) {
        this.db.prepare(
          "INSERT OR REPLACE INTO yahoo_symbols(source_key,symbol) VALUES (?,?)",
        ).run(sourceKey, history.symbol);
        return history.symbol;
      }
    }
    throw new Error(
      `Cannot resolve historical prices for ${instrument.ticker}.`,
    );
  }

  get(symbol: string, start: string, end?: string): Promise<PriceHistory> {
    // A single instance is shared by commands. Concurrent readers reuse the fetch.
    const key = JSON.stringify([symbol, start, end]);
    const existing = this.pending.get(key);
    if (existing) return existing;
    const previous = this.queues.get(symbol) ?? Promise.resolve();
    const result = previous.catch(() => {}).then(() =>
      this.load(symbol, start, end)
    )
      .finally(() => {
        this.pending.delete(key);
        if (this.queues.get(symbol) === result) this.queues.delete(symbol);
      });
    this.pending.set(key, result);
    this.queues.set(symbol, result);
    return result;
  }

  private async load(
    symbol: string,
    start: string,
    end?: string,
  ): Promise<PriceHistory> {
    if (symbol.startsWith(DATABENTO_PREFIX)) {
      return this.optionHistory.get(
        symbol.slice(DATABENTO_PREFIX.length),
        start,
        end,
      );
    }
    const option = yahooOptionContract(symbol);
    // A persisted fallback has already been tried after Yahoo failed; reuse it
    // across restarts without repeating failed Yahoo requests or paid backfills.
    if (option && this.optionHistory.has(option.symbol)) {
      return this.optionHistory.get(option.symbol, start, end);
    }
    try {
      const history = await this.loadYahoo(symbol, start);
      if (
        option && (history.instrumentType !== "OPTION" || !history.bars.length)
      ) {
        throw new Error(`Historical option prices unavailable for ${symbol}.`);
      }
      return history;
    } catch (error) {
      if (!option || !this.optionHistory.configured) throw error;
      return this.optionHistory.get(option.symbol, start, end);
    }
  }

  private async loadYahoo(
    symbol: string,
    start: string,
  ): Promise<PriceHistory> {
    const today = this.now().toISOString().slice(0, 10);
    const option = yahooOptionContract(symbol);
    if (option && option.expiry < today) {
      return this.loadExpiredOption(symbol, start, dayAfter(option.expiry));
    }
    const stableEnd = dayAfter(today, -2); // Two UTC days allow every exchange to finalize its close.
    const recent = this.db.prepare(
      "SELECT fetched_at,payload FROM yahoo_recent WHERE symbol = ?",
    ).get(symbol) as { fetched_at: number; payload: string } | undefined;
    let tail: PriceHistory;
    if (recent && +this.now() - recent.fetched_at < 5 * 60_000) {
      tail = JSON.parse(recent.payload);
    } else {
      tail = await fetchYahooHistory(
        symbol,
        stableEnd > start ? stableEnd : start,
        dayAfter(today),
        this.request,
      );
      this.db.prepare(
        "INSERT OR REPLACE INTO yahoo_recent(symbol,fetched_at,payload) VALUES (?,?,?)",
      ).run(symbol, +this.now(), JSON.stringify(tail));
    }
    for (const split of tail.splits) {
      this.db.prepare(
        "INSERT OR REPLACE INTO yahoo_splits(symbol,date,ratio) VALUES (?,?,?)",
      ).run(symbol, split.date, split.ratio);
    }
    const coverage = this.db.prepare(
      "SELECT start,end FROM yahoo_coverage WHERE symbol = ?",
    ).all(symbol) as Range[];
    // Fetch the newest gaps first: their split events are needed to undo Yahoo's
    // split adjustments when filling older gaps. Cached raw closes never rebase.
    for (const range of missingRanges(start, stableEnd, coverage).reverse()) {
      const history = await fetchYahooHistory(
        symbol,
        range.start,
        range.end,
        this.request,
      );
      this.persist(history, range);
    }
    const splits = this.db.prepare(
      "SELECT date,ratio FROM yahoo_splits WHERE symbol = ? ORDER BY date",
    ).all(symbol) as StockSplit[];
    const rows = this.db.prepare(
      "SELECT date,close,currency FROM yahoo_prices WHERE symbol = ? AND date >= ? ORDER BY date",
    ).all(symbol, start) as (PriceBar & { currency: string })[];
    const bars = new Map(
      rows.map((row) => [row.date, { date: row.date, close: row.close }]),
    );
    for (const bar of tail.bars) {
      if (bar.date >= start) {
        bars.set(bar.date, {
          ...bar,
          close: bar.close * this.futureSplitFactor(bar.date, splits),
        });
      }
    }
    return {
      symbol,
      currency: tail.currency,
      bars: [...bars.values()].sort((a, b) => a.date.localeCompare(b.date)),
      splits,
      instrumentType: tail.instrumentType,
    };
  }

  private async loadExpiredOption(
    symbol: string,
    start: string,
    end: string,
  ): Promise<PriceHistory> {
    const coverage = this.db.prepare(
      "SELECT start,end FROM yahoo_coverage WHERE symbol = ?",
    ).all(symbol) as Range[];
    for (const range of missingRanges(start, end, coverage)) {
      const history = await fetchYahooHistory(
        symbol,
        range.start,
        range.end,
        this.request,
      );
      if (history.instrumentType !== "OPTION") {
        throw new Error(`Invalid option history for ${symbol}.`);
      }
      this.persist(history, range);
    }
    const rows = this.db.prepare(
      "SELECT date,close,currency FROM yahoo_prices WHERE symbol = ? AND date >= ? AND date < ? ORDER BY date",
    ).all(symbol, start, end) as (PriceBar & { currency: string })[];
    return {
      symbol,
      currency: rows[0]?.currency ?? "USD",
      bars: rows.map(({ date, close }) => ({ date, close })),
      splits: [],
      instrumentType: "OPTION",
    };
  }

  private futureSplitFactor(date: string, splits: StockSplit[]) {
    return splits.reduce(
      (factor, split) => split.date > date ? factor * split.ratio : factor,
      1,
    );
  }

  private persist(history: PriceHistory, range: Range) {
    this.db.transaction(() => {
      for (const split of history.splits) {
        this.db.prepare(
          "INSERT OR REPLACE INTO yahoo_splits(symbol,date,ratio) VALUES (?,?,?)",
        ).run(history.symbol, split.date, split.ratio);
      }
      const splits = this.db.prepare(
        "SELECT date,ratio FROM yahoo_splits WHERE symbol = ? ORDER BY date",
      ).all(history.symbol) as StockSplit[];
      const insert = this.db.prepare(
        "INSERT OR REPLACE INTO yahoo_prices(symbol,date,close,currency) VALUES (?,?,?,?)",
      );
      for (const bar of history.bars) {
        insert.run(
          history.symbol,
          bar.date,
          bar.close * this.futureSplitFactor(bar.date, splits),
          history.currency,
        );
      }
      // Empty weekends/holidays are covered too; they must not be requested again.
      this.db.prepare(
        "INSERT OR IGNORE INTO yahoo_coverage(symbol,start,end) VALUES (?,?,?)",
      ).run(history.symbol, range.start, range.end);
    })();
  }
}
