import type { Database } from "../database/setup.ts";
import { logFetch } from "../../utils/fetch_logging.ts";
import {
  dayAfter,
  missingRanges,
  type PriceBar,
  type PriceHistory,
  type Range,
} from "./history.ts";
import { yahooOptionContract } from "./options.ts";

const API = "https://hist.databento.com/v0/";
const DATASET = "OPRA.PILLAR";
export const DATABENTO_PREFIX = "DATABENTO:";
export const databentoApiKey = () =>
  Deno.env.get("EYRI_DATABENTO_API_KEY")?.trim() ||
  Deno.env.get("DATABENTO_API_KEY")?.trim();

export function databentoOptionSymbol(symbol: string) {
  const contract = yahooOptionContract(symbol);
  if (!contract) {
    throw new Error("Databento fallback only supports option contracts.");
  }
  return contract.underlying.padEnd(6, " ") +
    contract.symbol.slice(contract.underlying.length);
}

const tradingDate = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/New_York",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});
function timestamp(value: unknown): bigint {
  if (typeof value !== "string" || !/^\d+$/.test(value)) {
    throw new Error("Invalid Databento trade timestamp.");
  }
  const result = BigInt(value);
  if (result <= 0 || result >= 18_446_744_073_709_551_615n) {
    throw new Error("Invalid Databento trade timestamp.");
  }
  return result;
}

async function apiRequest(
  method: string,
  params: Record<string, string>,
  key: string,
  request: typeof fetch,
) {
  const url = new URL(API + method);
  const post = method === "timeseries.get_range";
  if (!post) url.search = new URLSearchParams(params).toString();
  const response = await request(String(url), {
    method: post ? "POST" : "GET",
    headers: {
      Authorization: `Basic ${btoa(key + ":")}`,
      ...(post ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
    },
    ...(post ? { body: new URLSearchParams(params).toString() } : {}),
    redirect: "error",
    signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`Databento returned HTTP ${response.status}.`);
  }
  return response;
}

export async function fetchDatabentoOptionHistory(
  symbol: string,
  start: string,
  end: string,
  key: string,
  request: typeof fetch = fetch,
): Promise<PriceHistory> {
  return logFetch(`Databento option history ${symbol} ${start}..${end}`, async () => {
    const rawSymbol = databentoOptionSymbol(symbol);
    const response = await apiRequest(
      "timeseries.get_range",
      {
        dataset: DATASET,
        symbols: rawSymbol,
        schema: "trades",
        stype_in: "raw_symbol",
        start,
        end,
        encoding: "json",
        pretty_px: "true",
        pretty_ts: "false",
        map_symbols: "true",
      },
      key,
      request,
    );
    if (!response.body) throw new Error("Empty Databento response.");
    // OPRA OHLCV bars are per exchange. Stream all venues' trades and keep the
    // last trade of each New York session, rather than choosing an arbitrary venue.
    const daily = new Map<
      string,
      { event: bigint; received: bigint; close: number }
    >();
    const read = (line: string) => {
      if (!line.trim()) return;
      const record = JSON.parse(line);
      if (
        record.hd?.rtype !== 0 || record.action !== "T" ||
        record.symbol !== rawSymbol
      ) {
        throw new Error("Invalid Databento option trade.");
      }
      const event = timestamp(record.hd.ts_event),
        received = timestamp(record.ts_recv);
      const close = typeof record.price === "string" && record.price.trim() !== ""
        ? Number(record.price)
        : NaN;
      if (!Number.isFinite(close) || close < 0) {
        throw new Error("Invalid Databento option premium.");
      }
      const date = tradingDate.format(new Date(Number(event / 1_000_000n)));
      if (date < start || date >= end) return;
      const previous = daily.get(date);
      if (
        !previous || event > previous.event ||
        (event === previous.event && received >= previous.received)
      ) {
        daily.set(date, { event, received, close });
      }
    };
    const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
    let pending = "";
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        pending += value;
        let newline: number;
        while ((newline = pending.indexOf("\n")) !== -1) {
          read(pending.slice(0, newline));
          pending = pending.slice(newline + 1);
        }
      }
      read(pending);
    } finally {
      await reader.cancel();
      reader.releaseLock();
    }
    return {
      symbol: DATABENTO_PREFIX + yahooOptionContract(symbol)!.symbol,
      currency: "USD",
      instrumentType: "OPTION",
      splits: [],
      bars: [...daily].sort(([a], [b]) => a.localeCompare(b)).map((
        [date, { close }],
      ) => ({ date, close })),
    };
  }, (history) => history.bars.length);
}

export class DatabentoHistoryCache {
  private pending = new Map<string, Promise<PriceHistory>>();
  private queues = new Map<string, Promise<unknown>>();
  private availability?: { fetchedAt: number; range: Range };
  private availabilityRequest?: Promise<Range>;
  constructor(
    private db: Database,
    private request: typeof fetch = fetch,
    private now: () => Date = () => new Date(),
    private apiKey = databentoApiKey,
  ) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS databento_option_prices (symbol TEXT NOT NULL, date TEXT NOT NULL, close REAL NOT NULL, PRIMARY KEY(symbol,date));
      CREATE TABLE IF NOT EXISTS databento_option_coverage (symbol TEXT NOT NULL, start TEXT NOT NULL, end TEXT NOT NULL, PRIMARY KEY(symbol,start,end));
    `);
  }
  get configured() {
    return !!this.apiKey();
  }
  has(symbol: string) {
    return !!this.db.prepare(
      "SELECT 1 FROM databento_option_coverage WHERE symbol = ? LIMIT 1",
    ).get(symbol);
  }
  get(symbol: string, start: string, end?: string): Promise<PriceHistory> {
    const contract = yahooOptionContract(symbol);
    if (!contract) {
      return Promise.reject(
        new Error("Databento fallback only supports option contracts."),
      );
    }
    symbol = contract.symbol;
    const key = JSON.stringify([symbol, start, end]);
    const existing = this.pending.get(key);
    if (existing) return existing;
    const previous = this.queues.get(symbol) ?? Promise.resolve();
    const result = previous.catch(() => {}).then(() =>
      this.load(symbol, start, end)
    ).finally(() => {
      this.pending.delete(key);
      if (this.queues.get(symbol) === result) this.queues.delete(symbol);
    });
    this.pending.set(key, result);
    this.queues.set(symbol, result);
    return result;
  }
  private available(key: string): Promise<Range> {
    if (
      this.availability &&
      +this.now() - this.availability.fetchedAt < 5 * 60_000
    ) {
      return Promise.resolve(this.availability.range);
    }
    if (this.availabilityRequest) return this.availabilityRequest;
    this.availabilityRequest = logFetch("Databento dataset availability OPRA.PILLAR", async () => {
      const data = await (await apiRequest(
        "metadata.get_dataset_range",
        { dataset: DATASET },
        key,
        this.request,
      )).json();
      const available = data.schema?.trades;
      if (
        !available || !Number.isFinite(Date.parse(available.start)) ||
        !Number.isFinite(Date.parse(available.end))
      ) {
        throw new Error("Invalid Databento data availability.");
      }
      // Discard the provider's partial UTC day; only complete sessions are immutable.
      const range = {
        start: available.start.slice(0, 10),
        end: available.end.slice(0, 10),
      };
      this.availability = { fetchedAt: +this.now(), range };
      return range;
    }).finally(() => {
      this.availabilityRequest = undefined;
    });
    return this.availabilityRequest;
  }
  private async load(
    symbol: string,
    start: string,
    requestedEnd?: string,
  ): Promise<PriceHistory> {
    let end = [
      this.now().toISOString().slice(0, 10),
      dayAfter(yahooOptionContract(symbol)!.expiry),
      requestedEnd,
    ]
      .filter((v): v is string => !!v).sort()[0];
    const covered = this.db.prepare(
      "SELECT start,end FROM databento_option_coverage WHERE symbol = ?",
    ).all(symbol) as Range[];
    if (missingRanges(start, end, covered).length) {
      const key = this.apiKey();
      if (!key) throw new Error("Databento option history is not configured.");
      const available = await this.available(key);
      if (end > available.end) end = available.end;
      const from = start < available.start ? available.start : start;
      for (const missing of missingRanges(from, end, covered)) {
        // Bound requests to a month; keep only daily closes in SQLite.
        for (let cursor = missing.start; cursor < missing.end;) {
          const next = dayAfter(cursor, 31);
          const range = {
            start: cursor,
            end: next < missing.end ? next : missing.end,
          };
          const history = await fetchDatabentoOptionHistory(
            symbol,
            range.start,
            range.end,
            key,
            this.request,
          );
          this.db.transaction(() => {
            const insert = this.db.prepare(
              "INSERT OR REPLACE INTO databento_option_prices(symbol,date,close) VALUES (?,?,?)",
            );
            for (const bar of history.bars) {
              insert.run(symbol, bar.date, bar.close);
            }
            // Successful empty sessions are covered; failures never mark a range complete.
            this.db.prepare(
              "INSERT OR IGNORE INTO databento_option_coverage(symbol,start,end) VALUES (?,?,?)",
            ).run(symbol, range.start, range.end);
          })();
          cursor = range.end;
        }
      }
    }
    const bars = this.db.prepare(
      "SELECT date,close FROM databento_option_prices WHERE symbol = ? AND date >= ? AND date < ? ORDER BY date",
    ).all(symbol, start, end) as PriceBar[];
    return {
      symbol: DATABENTO_PREFIX + symbol,
      currency: "USD",
      instrumentType: "OPTION",
      splits: [],
      bars,
    };
  }
}
