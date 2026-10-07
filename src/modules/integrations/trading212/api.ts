import type { Trading212Credentials } from "./credentials.ts";
import { logFetch } from "../../../utils/fetch_logging.ts";

export type Trading212Instrument = {
  ticker: string;
  currency: string;
  isin?: string;
};

export type Trading212Position = {
  instrument: Trading212Instrument;
  quantity: number;
  averagePricePaid?: number;
  currentPrice?: number;
  createdAt?: string;
};

export type Trading212HistoricalOrder = {
  order: {
    instrument: Trading212Instrument;
    side: "BUY" | "SELL";
  };
  fill?: {
    id: number;
    filledAt: string;
    quantity: number;
    price: number;
    type: string;
  };
};

export type Trading212HistoryPage = {
  items: Trading212HistoricalOrder[];
  nextPagePath: string | null;
};

export type Trading212Transaction = {
  reference: string;
  dateTime: string;
  amount: number;
  currency: string;
  type: string;
};

export type Trading212TransactionPage = {
  items: Trading212Transaction[];
  nextPagePath: string | null;
};

type Runtime = {
  fetch: typeof fetch;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
};

// Only these read endpoints are used. Reject arbitrary pagination URLs before
// attaching credentials, including redirects to other servers.
const intervals: Record<string, number> = {
  "/api/v0/equity/positions": 1_000,
  "/api/v0/equity/history/orders": 3_100,
  "/api/v0/equity/history/transactions": 10_100,
};

export class Trading212Client {
  private readonly origin = "https://live.trading212.com";
  private readonly authorization: string;
  private readonly runtime: Runtime;
  private readonly queues = new Map<string, Promise<unknown>>();
  private readonly nextAllowed = new Map<string, number>();

  constructor(
    credentials: Trading212Credentials,
    runtime: Partial<Runtime> = {},
  ) {
    this.authorization = `Basic ${
      btoa(`${credentials.apiKey}:${credentials.secretKey}`)
    }`;
    this.runtime = {
      fetch: (...args) => globalThis.fetch(...args),
      now: () => Date.now(),
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      ...runtime,
    };
  }

  get<T>(path: string): Promise<T> {
    const url = new URL(path, this.origin);
    if (
      url.origin !== this.origin || url.username || url.password || url.hash ||
      !(url.pathname in intervals)
    ) {
      return Promise.reject(new Error("Invalid Trading 212 API path"));
    }
    const previous = this.queues.get(url.pathname) ?? Promise.resolve();
    const request = previous.catch(() => {}).then(() =>
      logFetch(
        `Trading 212 ${url.pathname}`,
        () => this.request<T>(url),
        (result) => {
          if (
            result && typeof result === "object" && "items" in result &&
            Array.isArray(result.items)
          ) return result.items.length;
          return undefined;
        },
      )
    );
    this.queues.set(url.pathname, request);
    return request;
  }

  private async request<T>(url: URL): Promise<T> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const delay = (this.nextAllowed.get(url.pathname) ?? 0) -
        this.runtime.now();
      if (delay > 60_000) {
        throw new Error("Trading 212 rate limit reached; try again later");
      }
      if (delay > 0) {
        console.log(
          `Trading 212 ${url.pathname}: waiting ${delay}ms for rate limit`,
        );
        await this.runtime.sleep(delay);
      }
      this.nextAllowed.set(
        url.pathname,
        this.runtime.now() + intervals[url.pathname],
      );
      let response: Response;
      try {
        response = await this.runtime.fetch(url, {
          method: "GET",
          headers: { Authorization: this.authorization },
          redirect: "error",
          signal: AbortSignal.timeout(20_000),
        });
      } catch {
        throw new Error("Trading 212 request failed or timed out");
      }
      if (
        response.status === 429 ||
        response.headers.get("x-ratelimit-remaining") === "0"
      ) {
        const reset = Number(response.headers.get("x-ratelimit-reset")) * 1_000;
        const retryAfter = Number(response.headers.get("retry-after")) * 1_000;
        const now = this.runtime.now();
        const retryAt = reset > now
          ? reset
          : now + (retryAfter > 0
            ? retryAfter
            : (response.status === 429 ? 60_000 : 0));
        this.nextAllowed.set(
          url.pathname,
          Math.max(
            this.nextAllowed.get(url.pathname) ?? 0,
            Number.isFinite(retryAt) ? retryAt : now + 60_000,
          ),
        );
      }
      if (response.status === 429 && attempt === 0) {
        console.warn(`Trading 212 ${url.pathname}: HTTP 429, retrying`);
        await response.body?.cancel();
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel();
        const hint = response.status === 401
          ? ": check the key and secret generated in your live account"
          : response.status === 403
          ? ": check read permissions and IP restrictions"
          : "";
        throw new Error(
          `Trading 212 API returned HTTP ${response.status}${hint}`,
        );
      }
      try {
        return await response.json() as T;
      } catch {
        throw new Error("Trading 212 API returned invalid JSON");
      }
    }
    throw new Error("Trading 212 rate limit reached; try again later");
  }
}

const clients = new Map<string, { secret: string; client: Trading212Client }>();

export function getTrading212Client(credentials: Trading212Credentials) {
  const key = credentials.apiKey;
  const existing = clients.get(key);
  if (existing?.secret === credentials.secretKey) return existing.client;
  const client = new Trading212Client(credentials);
  clients.set(key, { secret: credentials.secretKey, client });
  return client;
}
