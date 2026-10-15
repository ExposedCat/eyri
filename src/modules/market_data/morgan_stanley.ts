import type { Database } from "../database/setup.ts";
import { logFetch } from "../../utils/fetch_logging.ts";
import { dayAfter, type PriceBar, type PriceHistory } from "./history.ts";

export const MORGAN_STANLEY_PREFIX = "MORGAN_STANLEY:";
const ORIGIN = "https://zertifikate.morganstanley.com";
const TTL = 5 * 60_000;

// A WKN only identifies a candidate. The product page must still confirm the
// ISIN, issuer, product type and quote currency before accepting its chart.
export function morganStanleyIsin(instrument: {
  ticker: string;
  currency: string;
  isin?: string;
}) {
  const ticker = instrument.ticker.trim().toUpperCase();
  const supplied = instrument.isin?.trim().toUpperCase() ??
    (ticker.startsWith("DE000") ? ticker : undefined);
  const wkn = supplied
    ? supplied.match(/^DE000(M[A-Z0-9]{5})\d$/)?.[1]
    : instrument.currency.trim().toUpperCase() === "EUR"
    ? ticker.match(/^(M[A-Z0-9]{5})(?:\.(?:DE|F|SG))?$/)?.[1]
    : undefined;
  if (!wkn) return undefined;
  const base = "DE000" + wkn;
  const digits = [...base].map((c) =>
    /[A-Z]/.test(c) ? String(c.charCodeAt(0) - 55) : c
  ).join("");
  const sum = [...digits].reverse().reduce((sum, c, i) => {
    const n = Number(c) * (i % 2 === 0 ? 2 : 1);
    return sum + (n > 9 ? n - 9 : n);
  }, 0);
  const isin = base + (10 - sum % 10) % 10;
  return !supplied || supplied === isin ? isin : undefined;
}

export class NotMorganStanleyWarrantError extends Error {}
export class MorganStanleyHistoryError extends Error {
  constructor(readonly isin: string, cause: unknown) {
    super(`Morgan Stanley warrant history unavailable for ${isin}.`, { cause });
    this.name = "MorganStanleyHistoryError";
  }
}

async function response(path: string, request: typeof fetch) {
  const result = await request(ORIGIN + path, {
    headers: { "User-Agent": "Mozilla/5.0 Eyri/1.0" },
    redirect: "error",
    signal: AbortSignal.timeout(20_000),
  });
  if (!result.ok) {
    await result.body?.cancel();
    if (result.status === 404 && path.startsWith("/produktdetails/")) {
      throw new NotMorganStanleyWarrantError(
        "Morgan Stanley product not found.",
      );
    }
    throw new Error(`Morgan Stanley returned HTTP ${result.status}.`);
  }
  return result;
}

async function fetchProduct(isin: string, request: typeof fetch) {
  return await logFetch(`Morgan Stanley product ${isin}`, async () => {
    const html = await (await response(
      `/produktdetails/${isin.toLowerCase()}`,
      request,
    )).text();
    const field = (name: string) =>
      html.match(
        new RegExp(
          `<span\\b[^>]*\\bdata-prop="${name}"[^>]*>\\s*([^<]+?)\\s*</span>`,
          "i",
        ),
      )?.[1]?.trim();
    const currency = field("CurrencyIsoCode");
    if (
      field("Isin") !== isin ||
      !/\bMORGAN STANLEY\b/i.test(field("IssuerName") ?? "") ||
      field("ProductTypeTranslation") !== "Optionsschein" ||
      !currency || !/^[A-Z]{3}$/.test(currency) ||
      !html.includes(`data-friendly-id="${isin}"`)
    ) {
      throw new NotMorganStanleyWarrantError(
        "Not a supported Morgan Stanley warrant.",
      );
    }
    return { currency };
  });
}

export async function fetchMorganStanleyHistory(
  isin: string,
  currency: string,
  request: typeof fetch = fetch,
): Promise<PriceHistory> {
  return await logFetch(`Morgan Stanley history ${isin}`, async () => {
    const data = await (await response(
      `/de-DE/UnitedChart/ProductChartData?friendlyId=${isin}&period=FiveYears`,
      request,
    )).json();
    const series = Array.isArray(data?.Diagrams)
      ? data.Diagrams.filter((s: { Name?: string }) =>
        s.Name === data.ProductName
      )
      : [];
    if (
      data.IsNormalized !== false || data.ProductName === data.UnderlyingName ||
      series.length !== 1 || series[0].ValueSuffix !== currency ||
      !Array.isArray(series[0].Data) || !series[0].Data.length
    ) {
      throw new Error(
        "No unnormalized Morgan Stanley product prices returned.",
      );
    }
    const dates = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Europe/Berlin",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    const bars = new Map<string, PriceBar>();
    for (const point of series[0].Data) {
      if (
        !Array.isArray(point) || point.length !== 2 ||
        !Number.isSafeInteger(point[0]) || point[0] <= 0 ||
        !Number.isFinite(new Date(point[0]).getTime()) ||
        typeof point[1] !== "number" || !Number.isFinite(point[1]) ||
        point[1] < 0
      ) throw new Error("Invalid Morgan Stanley daily price.");
      const date = dates.format(new Date(point[0]));
      // FiveYears must return daily prices, never intraday or grouped samples.
      if (bars.has(date)) {
        throw new Error("Duplicate Morgan Stanley daily price.");
      }
      bars.set(date, { date, close: point[1] });
    }
    return {
      symbol: MORGAN_STANLEY_PREFIX + isin,
      currency,
      instrumentType: "WARRANT",
      priceBasis: "BID",
      splits: [],
      bars: [...bars.values()].sort((a, b) => a.date.localeCompare(b.date)),
    };
  });
}

export class MorganStanleyHistoryCache {
  private pending = new Map<string, Promise<PriceHistory>>();
  constructor(
    private db: Database,
    private request: typeof fetch = fetch,
    private now: () => Date = () => new Date(),
  ) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS morgan_stanley_products (isin TEXT PRIMARY KEY, currency TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS morgan_stanley_prices (isin TEXT NOT NULL, date TEXT NOT NULL, close REAL NOT NULL, PRIMARY KEY(isin,date));
      CREATE TABLE IF NOT EXISTS morgan_stanley_recent (isin TEXT PRIMARY KEY, fetched_at REAL NOT NULL, payload TEXT NOT NULL);
    `);
  }
  async get(isin: string, start: string, end?: string): Promise<PriceHistory> {
    let pending = this.pending.get(isin);
    if (!pending) {
      pending = this.load(isin).finally(() => this.pending.delete(isin));
      this.pending.set(isin, pending);
    }
    const history = await pending;
    const through = end ?? dayAfter(this.now().toISOString().slice(0, 10));
    return {
      ...history,
      bars: history.bars.filter((b) => b.date >= start && b.date < through),
    };
  }
  private async load(isin: string): Promise<PriceHistory> {
    if (morganStanleyIsin({ ticker: isin, currency: "EUR" }) !== isin) {
      throw new Error("Invalid Morgan Stanley ISIN.");
    }
    const product = this.db.prepare(
      "SELECT currency FROM morgan_stanley_products WHERE isin = ?",
    ).get(isin) as { currency: string } | undefined ??
      await fetchProduct(isin, this.request);
    const recent = this.db.prepare(
      "SELECT fetched_at,payload FROM morgan_stanley_recent WHERE isin = ?",
    ).get(isin) as { fetched_at: number; payload: string } | undefined;
    const history: PriceHistory =
      recent && +this.now() - recent.fetched_at < TTL
        ? JSON.parse(recent.payload)
        : await fetchMorganStanleyHistory(isin, product.currency, this.request);
    if (!recent || +this.now() - recent.fetched_at >= TTL) {
      const stableEnd = dayAfter(this.now().toISOString().slice(0, 10), -2);
      this.db.transaction(() => {
        this.db.prepare(
          "INSERT OR IGNORE INTO morgan_stanley_products(isin,currency) VALUES (?,?)",
        ).run(isin, product.currency);
        const insert = this.db.prepare(
          "INSERT OR IGNORE INTO morgan_stanley_prices(isin,date,close) VALUES (?,?,?)",
        );
        for (const bar of history.bars) {
          if (bar.date < stableEnd) insert.run(isin, bar.date, bar.close);
        }
        this.db.prepare(
          "INSERT OR REPLACE INTO morgan_stanley_recent(isin,fetched_at,payload) VALUES (?,?,?)",
        ).run(isin, +this.now(), JSON.stringify(history));
      })();
    }
    const rows = this.db.prepare(
      "SELECT date,close FROM morgan_stanley_prices WHERE isin = ? ORDER BY date",
    ).all(isin) as PriceBar[];
    const bars = new Map(history.bars.map((b) => [b.date, b]));
    for (const row of rows) bars.set(row.date, row);
    return {
      ...history,
      bars: [...bars.values()].sort((a, b) => a.date.localeCompare(b.date)),
    };
  }
}
