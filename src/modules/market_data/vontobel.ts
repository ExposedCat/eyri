import type { Database } from "../database/setup.ts";
import type { IntegrationPortfolioPosition } from "../integrations/types.ts";
import { logFetch } from "../../utils/fetch_logging.ts";
import {
  dayAfter,
  missingRanges,
  type PriceBar,
  type PriceHistory,
  type Range,
} from "./history.ts";

export const VONTOBEL_PREFIX = "VONTOBEL:";
const API = "https://markets.vontobel.com/api/v1/";
const DAY = 86_400_000;
const TTL = 5 * 60_000;

function checksum(value: string) {
  const digits = [...value].map((c) =>
    /[A-Z]/.test(c) ? String(c.charCodeAt(0) - 55) : c
  ).join("");
  return [...digits].reverse().reduce((sum, c, i) => {
    const n = Number(c) * (i % 2 === 0 ? 2 : 1);
    return sum + (n > 9 ? n - 9 : n);
  }, 0);
}

// German ISINs consist of DE000 + WKN + a Luhn check digit. A candidate
// still needs issuer verification; a six-character stock must never be guessed.
export function vontobelIsin(
  instrument: { ticker: string; isin?: string; currency: string },
) {
  const ticker = instrument.ticker.trim().toUpperCase();
  const supplied = instrument.isin?.trim().toUpperCase();
  const isin = supplied ??
    (/^DE000V[A-Z0-9]{5}\d$/.test(ticker) ? ticker : undefined);
  if (isin) {
    if (!/^DE000V[A-Z0-9]{5}\d$/.test(isin)) return undefined;
    const expected = (10 - checksum(isin.slice(0, -1)) % 10) % 10;
    return Number(isin.at(-1)) === expected ? isin : undefined;
  }
  if (instrument.currency.trim().toUpperCase() !== "EUR") return undefined;
  const wkn = ticker.match(/^(V[A-Z0-9]{5})(?:\.(?:DE|F|SG))?$/)?.[1];
  if (!wkn) return undefined;
  const base = "DE000" + wkn;
  return base + (10 - checksum(base) % 10) % 10;
}

export class VontobelHistoryError extends Error {
  constructor(readonly isin: string, cause: unknown) {
    super(`Vontobel warrant history unavailable for ${isin}.`, { cause });
    this.name = "VontobelHistoryError";
  }
}

export class NotVontobelWarrantError extends Error {}

function apiRequest(path: string, request: typeof fetch) {
  return logFetch(`Vontobel ${path}`, async () => {
    const response = await request(API + path + "?c=de-de", {
      headers: {
        "User-Agent": "Mozilla/5.0 Eyri/1.0",
        Accept: "application/json",
      },
      redirect: "error",
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) {
      await response.body?.cancel();
      if (response.status === 404 && path.startsWith("productdetailpage/")) {
        throw new NotVontobelWarrantError("Vontobel product not found.");
      }
      throw new Error(`Vontobel returned HTTP ${response.status}.`);
    }
    const data = await response.json();
    if (data?.isSuccess !== true || !data.payload) {
      throw new Error("Invalid Vontobel response.");
    }
    return data.payload;
  });
}

type Product = { currency: string; lastTrade?: string };
type ProductPayload = {
  data?: {
    isin?: string;
    issuer?: string;
    productType?: number;
    currency?: string;
  };
  priceFactor?: number;
  lifeCycle?: { type: number; occurrence?: string }[];
  price?: {
    currency?: string;
    isPercentPrice?: boolean;
    bid?: number;
    latestTimestamp?: string;
  };
};
function parseProduct(isin: string, product: ProductPayload): Product {
  const currency = product.data?.currency;
  if (
    product.data?.isin !== isin ||
    !/\bvontobel\b/i.test(product.data?.issuer ?? "") ||
    product.data?.productType !== 3 || product.priceFactor !== 1 ||
    typeof currency !== "string" || !/^[A-Z]{3}$/.test(currency)
  ) {
    throw new NotVontobelWarrantError("Not a supported Vontobel warrant.");
  }
  const lastTrade = product.lifeCycle?.find((event: { type: number }) =>
    event.type === 6
  )?.occurrence;
  if (
    lastTrade !== undefined &&
    (typeof lastTrade !== "string" || !Number.isFinite(Date.parse(lastTrade)))
  ) {
    throw new Error("Invalid Vontobel last trading date.");
  }
  return {
    currency,
    ...(lastTrade ? { lastTrade: lastTrade.slice(0, 10) } : {}),
  };
}

async function fetchProduct(
  isin: string,
  request: typeof fetch,
): Promise<Product> {
  const product = await apiRequest(`productdetailpage/${isin}`, request);
  return parseProduct(isin, product);
}

export async function fetchVontobelQuote(
  isin: string,
  request: typeof fetch = fetch,
) {
  const payload: ProductPayload = await apiRequest(
    `productdetailpage/${isin}`,
    request,
  );
  const product = parseProduct(isin, payload);
  const price = payload.price;
  if (
    price?.currency !== product.currency || price.isPercentPrice !== false ||
    typeof price.bid !== "number" || !Number.isFinite(price.bid) ||
    price.bid < 0 ||
    typeof price.latestTimestamp !== "string" ||
    !Number.isFinite(Date.parse(price.latestTimestamp))
  ) {
    throw new Error(`Invalid Vontobel bid quote for ${isin}.`);
  }
  return {
    currency: product.currency,
    bid: price.bid,
    timestamp: price.latestTimestamp,
  };
}

export async function enrichPortfolioWithVontobelQuotes(
  positions: IntegrationPortfolioPosition[],
  request: typeof fetch = fetch,
) {
  const quotes = new Map<string, ReturnType<typeof fetchVontobelQuote>>();
  return await Promise.all(positions.map(async (position) => {
    if (
      position.assetCategory?.trim().toUpperCase() !== "WAR" ||
      position.amount === 0
    ) {
      return position;
    }
    const isin = vontobelIsin(position);
    if (!isin) return position;
    let quote = quotes.get(isin);
    if (!quote) {
      quote = fetchVontobelQuote(isin, request);
      quotes.set(isin, quote);
    }
    try {
      const { bid, currency, timestamp } = await quote;
      if (currency !== position.currency.trim().toUpperCase()) {
        throw new Error("Vontobel quote currency does not match the holding.");
      }
      const totalNow = position.amount * bid;
      return {
        ...position,
        currentPrice: bid,
        totalNow,
        unrealizedPnl: position.totalInput === null
          ? null
          : totalNow - position.totalInput,
        currentPriceSource: "vontobel_bid",
        currentPriceAsOf: timestamp,
      };
    } catch (cause) {
      throw new Error(
        `Vontobel bid quote unavailable for ${position.ticker} (${isin}).`,
        { cause },
      );
    }
  }));
}

export async function fetchVontobelHistory(
  isin: string,
  currency: string,
  request: typeof fetch = fetch,
): Promise<PriceHistory> {
  const payload = await apiRequest(`charts/products/${isin}/detail/6`, request);
  const series = payload.series?.filter((
    s: { isProduct?: boolean; priceIdentifier?: string },
  ) => s.isProduct === true && s.priceIdentifier === isin);
  if (
    !series || series.length !== 1 || !Array.isArray(series[0].points) ||
    !series[0].points.length
  ) {
    throw new Error("No Vontobel daily bid prices returned.");
  }
  const bars = new Map<string, PriceBar>();
  for (const point of series[0].points) {
    // Max-range daily timestamps are UTC midnight labels, not exchange ticks.
    if (
      !Number.isSafeInteger(point.timestamp) || point.timestamp <= 0 ||
      point.timestamp % DAY !== 0 ||
      typeof point.bid !== "number" || !Number.isFinite(point.bid) ||
      point.bid < 0
    ) {
      throw new Error("Invalid Vontobel daily bid price.");
    }
    const date = new Date(point.timestamp).toISOString().slice(0, 10);
    if (bars.has(date)) throw new Error("Duplicate Vontobel daily bid price.");
    bars.set(date, { date, close: point.bid });
  }
  return {
    symbol: VONTOBEL_PREFIX + isin,
    currency,
    instrumentType: "WARRANT",
    priceBasis: "BID",
    splits: [],
    bars: [...bars.values()].sort((a, b) => a.date.localeCompare(b.date)),
  };
}

export class VontobelHistoryCache {
  private queues = new Map<string, Promise<PriceHistory>>();
  constructor(
    private db: Database,
    private request: typeof fetch = fetch,
    private now: () => Date = () => new Date(),
  ) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS vontobel_products (isin TEXT PRIMARY KEY, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS vontobel_prices (isin TEXT NOT NULL, date TEXT NOT NULL, close REAL NOT NULL, PRIMARY KEY(isin,date));
      CREATE TABLE IF NOT EXISTS vontobel_coverage (isin TEXT NOT NULL, start TEXT NOT NULL, end TEXT NOT NULL, PRIMARY KEY(isin,start,end));
      CREATE TABLE IF NOT EXISTS vontobel_recent (isin TEXT PRIMARY KEY, fetched_at REAL NOT NULL, payload TEXT NOT NULL);
    `);
  }
  get(isin: string, start: string, end?: string): Promise<PriceHistory> {
    const previous = this.queues.get(isin) ?? Promise.resolve();
    const result = previous.catch(() => {}).then(() =>
      this.load(isin, start, end)
    ).finally(() => {
      if (this.queues.get(isin) === result) this.queues.delete(isin);
    });
    this.queues.set(isin, result);
    return result;
  }
  private async load(
    isin: string,
    start: string,
    requestedEnd?: string,
  ): Promise<PriceHistory> {
    if (vontobelIsin({ ticker: isin, currency: "EUR" }) !== isin) {
      throw new Error("Invalid Vontobel ISIN.");
    }
    const stored = this.db.prepare(
      "SELECT payload FROM vontobel_products WHERE isin = ?",
    ).get(isin) as { payload: string } | undefined;
    const product: Product = stored
      ? JSON.parse(stored.payload)
      : await fetchProduct(isin, this.request);
    if (!stored) {
      this.db.prepare(
        "INSERT INTO vontobel_products(isin,payload) VALUES (?,?)",
      ).run(isin, JSON.stringify(product));
    }
    const today = this.now().toISOString().slice(0, 10);
    const end = [
      requestedEnd ?? dayAfter(today),
      ...(product.lastTrade ? [dayAfter(product.lastTrade)] : []),
    ].sort()[0];
    const stableEnd = [end, dayAfter(today, -2)].sort()[0];
    const cacheStableEnd = [
      dayAfter(today, -2),
      ...(product.lastTrade ? [dayAfter(product.lastTrade)] : []),
    ].sort()[0];
    const coverage = this.db.prepare(
      "SELECT start,end FROM vontobel_coverage WHERE isin = ?",
    ).all(isin) as Range[];
    let tail: PriceHistory | undefined;
    if (end > stableEnd || missingRanges(start, stableEnd, coverage).length) {
      const recent = this.db.prepare(
        "SELECT fetched_at,payload FROM vontobel_recent WHERE isin = ?",
      ).get(isin) as { fetched_at: number; payload: string } | undefined;
      tail = recent && +this.now() - recent.fetched_at < TTL
        ? JSON.parse(recent.payload)
        : await fetchVontobelHistory(isin, product.currency, this.request);
      if (!recent || +this.now() - recent.fetched_at >= TTL) {
        // The endpoint returns the entire available lifetime in one request.
        const expired = product.lastTrade &&
          dayAfter(product.lastTrade) <= dayAfter(today, -2);
        const coveredEnd = expired
          ? cacheStableEnd
          : [cacheStableEnd, dayAfter(tail!.bars.at(-1)!.date)].sort()[0];
        this.db.transaction(() => {
          const insert = this.db.prepare(
            "INSERT OR IGNORE INTO vontobel_prices(isin,date,close) VALUES (?,?,?)",
          );
          for (const bar of tail!.bars) {
            if (bar.date < cacheStableEnd) {
              insert.run(isin, bar.date, bar.close);
            }
          }
          this.db.prepare(
            "INSERT OR REPLACE INTO vontobel_coverage(isin,start,end) VALUES (?,?,?)",
          ).run(isin, "1970-01-01", coveredEnd);
          this.db.prepare(
            "INSERT OR REPLACE INTO vontobel_recent(isin,fetched_at,payload) VALUES (?,?,?)",
          ).run(isin, +this.now(), JSON.stringify(tail));
        })();
      }
    }
    const rows = this.db.prepare(
      "SELECT date,close FROM vontobel_prices WHERE isin = ? AND date >= ? AND date < ? ORDER BY date",
    ).all(isin, start, end) as PriceBar[];
    const bars = new Map(rows.map((bar) => [bar.date, bar]));
    for (const bar of tail?.bars ?? []) {
      if (bar.date >= start && bar.date < end && !bars.has(bar.date)) {
        bars.set(bar.date, bar);
      }
    }
    return {
      symbol: VONTOBEL_PREFIX + isin,
      currency: product.currency,
      instrumentType: "WARRANT",
      priceBasis: "BID",
      splits: [],
      bars: [...bars.values()].sort((a, b) => a.date.localeCompare(b.date)),
    };
  }
}
