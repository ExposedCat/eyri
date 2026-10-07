import type { Integration } from "../../database/integration.ts";
import type { Database } from "../../database/setup.ts";
import type {
  IntegrationAdapter,
  IntegrationOrder,
  IntegrationPortfolioPosition,
} from "../types.ts";
import {
  getTrading212Client,
  type Trading212HistoricalOrder,
  type Trading212HistoryPage,
  type Trading212Instrument,
  type Trading212Position,
} from "./api.ts";
import { parseTrading212Credentials } from "./credentials.ts";
import { fetchTrading212CashHistory } from "./transactions.ts";
import {
  buildCfdHistoryOrders,
  buildCfdPositions,
} from "../../tickers/cfd_history.ts";

const HISTORY_PATH = "/api/v0/equity/history/orders";
const HISTORY_CACHE_MS = 60_000;

function numberOrNull(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function instrumentFields(instrument: Trading212Instrument) {
  if (!instrument?.ticker?.trim() || !instrument?.currency?.trim()) {
    throw new Error("Trading 212 response is missing instrument information");
  }
  const rawTicker = instrument.ticker.trim().toUpperCase();
  // US stocks use IBKR's symbol convention. Preserve other instrument IDs to
  // avoid merging different listings that happen to share a short symbol.
  const ticker = rawTicker.match(/^(.+)_US_EQ$/)?.[1] ?? rawTicker;
  const venue = instrument.ticker.trim().match(/^(.+)([dlp])_EQ$/);
  const suffix: Record<string, string> = { d: ".DE", l: ".L", p: ".PA" };
  return {
    ticker,
    currency: instrument.currency.trim().toUpperCase(),
    ...(venue
      ? { yahooSymbol: `${venue[1].toUpperCase()}${suffix[venue[2]]}` }
      : {}),
    ...(instrument.isin ? { isin: instrument.isin } : {}),
  };
}

function baseFields(integration: Integration) {
  return {
    integrationId: integration.id,
    integrationKind: integration.kind,
    account: `Trading 212 #${integration.id}`,
  };
}

export function toTrading212Position(
  integration: Integration,
  position: Trading212Position,
): IntegrationPortfolioPosition | null {
  const amount = numberOrNull(position.quantity);
  if (amount === null || amount < 0) {
    throw new Error("Invalid Trading 212 position quantity");
  }
  if (amount === 0) return null;
  const averageUnitPrice = numberOrNull(position.averagePricePaid);
  const currentPrice = numberOrNull(position.currentPrice);
  // Prices and totals must share the instrument currency. Wallet-impact values
  // are account-currency amounts and cannot be mixed into these calculations.
  const totalInput = averageUnitPrice === null
    ? null
    : averageUnitPrice * amount;
  const totalNow = currentPrice === null ? null : currentPrice * amount;
  const openedAt = position.createdAt ? new Date(position.createdAt) : null;
  return {
    ...baseFields(integration),
    ...instrumentFields(position.instrument),
    amount,
    averageUnitPrice,
    currentPrice,
    totalInput,
    totalNow,
    unrealizedPnl: totalNow === null || totalInput === null
      ? null
      : totalNow - totalInput,
    realizedPnl: null,
    dailyPnl: null,
    dailyPnlPercentage: null,
    dailyPnlBaseline: null,
    openedAt: openedAt && Number.isFinite(+openedAt) ? openedAt : null,
  };
}

export function toTrading212Order(
  integration: Integration,
  item: Trading212HistoricalOrder,
): IntegrationOrder | null {
  if (!item.fill) return null;
  const { fill, order } = item;
  if (fill.type !== "TRADE") {
    throw new Error(
      `Trading 212 history contains an unsupported corporate action (${fill.type}); FIFO history cannot be calculated reliably`,
    );
  }
  const quantity = numberOrNull(fill.quantity);
  const price = numberOrNull(fill.price);
  const date = new Date(fill.filledAt);
  if (
    quantity === null || quantity === 0 || price === null || price < 0 ||
    !Number.isFinite(+date) || (order.side !== "BUY" && order.side !== "SELL")
  ) {
    throw new Error("Invalid Trading 212 execution in order history");
  }
  return {
    ...baseFields(integration),
    ...instrumentFields(order.instrument),
    quantity: order.side === "SELL" ? -Math.abs(quantity) : Math.abs(quantity),
    price,
    date,
    assetCategory: "STK",
  };
}

function ensureHistorySchema(database: Database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS trading212_fills (
      integration_id INTEGER NOT NULL REFERENCES integrations(id) ON DELETE CASCADE,
      fill_id TEXT NOT NULL,
      payload TEXT NOT NULL,
      PRIMARY KEY (integration_id, fill_id)
    );
    CREATE TABLE IF NOT EXISTS trading212_history_sync (
      integration_id INTEGER PRIMARY KEY REFERENCES integrations(id) ON DELETE CASCADE,
      synced_at REAL NOT NULL
    );
  `);
}

function readHistory(database: Database, integration: Integration) {
  const rows = database.prepare(
    "SELECT payload FROM trading212_fills WHERE integration_id = ?",
  ).all(integration.id) as { payload: string }[];
  return rows.flatMap(({ payload }) => {
    const order = toTrading212Order(integration, JSON.parse(payload));
    return order ? [order] : [];
  }).sort((a, b) => +a.date - +b.date);
}

async function syncHistory(database: Database, integration: Integration) {
  ensureHistorySchema(database);
  const client = getTrading212Client(
    parseTrading212Credentials(integration.credentials),
  );
  const state = database.prepare(
    // The SQLite driver decodes INTEGER as int32. CAST also fixes databases
    // created before this column used REAL, without losing cached history.
    "SELECT CAST(synced_at AS REAL) AS synced_at FROM trading212_history_sync WHERE integration_id = ?",
  ).get(integration.id) as { synced_at: number } | undefined;
  if (state && Date.now() - state.synced_at < HISTORY_CACHE_MS) {
    return readHistory(database, integration);
  }
  const knownRows = database.prepare(
    "SELECT fill_id FROM trading212_fills WHERE integration_id = ?",
  ).all(integration.id) as { fill_id: string }[];
  const known = new Set(knownRows.map((row) => row.fill_id));
  const visited = new Set<string>();
  let path: string | null = `${HISTORY_PATH}?limit=50`;
  while (path) {
    // The API client additionally validates origin; restrict pagination to the
    // history endpoint so unrelated responses never count as a completed sync.
    if (path.split("?")[0] !== HISTORY_PATH || visited.has(path)) {
      throw new Error("Invalid Trading 212 history pagination");
    }
    visited.add(path);
    const page: Trading212HistoryPage = await client.get(path);
    if (
      !Array.isArray(page.items) ||
      (page.nextPagePath !== null && typeof page.nextPagePath !== "string")
    ) {
      throw new Error("Invalid Trading 212 order history response");
    }
    const fills = page.items.filter((item) => item.fill);
    for (const item of fills) {
      if (!Number.isSafeInteger(item.fill!.id)) {
        throw new Error("Invalid Trading 212 fill ID");
      }
    }
    database.transaction(() => {
      const insert = database.prepare(`
        INSERT INTO trading212_fills (integration_id, fill_id, payload) VALUES (?, ?, ?)
        ON CONFLICT(integration_id, fill_id) DO UPDATE SET payload = excluded.payload
      `);
      for (const item of fills) {
        insert.run(integration.id, String(item.fill!.id), JSON.stringify(item));
      }
    })();
    // A prior complete sync permits stopping at an entirely known page. An
    // interrupted first sync must still paginate all the way to the end.
    if (
      state && fills.length > 0 &&
      fills.every((item) => known.has(String(item.fill!.id)))
    ) break;
    path = page.nextPagePath;
  }
  const orders = readHistory(database, integration);
  database.prepare(`
    INSERT INTO trading212_history_sync (integration_id, synced_at) VALUES (?, ?)
    ON CONFLICT(integration_id) DO UPDATE SET synced_at = excluded.synced_at
  `).run(integration.id, Date.now());
  return orders;
}

const pendingHistory = new WeakMap<
  Database,
  Map<number, Promise<IntegrationOrder[]>>
>();

const pendingCfd = new WeakMap<
  Database,
  Map<number, Promise<IntegrationOrder[]>>
>();

function fetchCfdOrders(database: Database, integration: Integration) {
  let pending = pendingCfd.get(database);
  if (!pending) {
    pending = new Map();
    pendingCfd.set(database, pending);
  }
  const existing = pending.get(integration.id);
  if (existing) return existing;
  const request = (async () => {
    const orders = await buildCfdHistoryOrders(
      await fetchTrading212CashHistory(database, integration),
    );
    // Preserve bucket assignments from the former single net-transfer row.
    // Replace it with purchase keys so normal move/remove controls still work.
    const legacyKey = `t212:CFD:${integration.id}`;
    const legacy = database.prepare(
      "SELECT bucket_name FROM portfolio_bucket_transactions WHERE user_id = ? AND transaction_key = ?",
    ).get(integration.userId, legacyKey) as { bucket_name: string } | undefined;
    if (legacy && orders.length) {
      database.transaction(() => {
        const insert = database.prepare(
          "INSERT OR IGNORE INTO portfolio_bucket_transactions (user_id, transaction_key, bucket_name) VALUES (?, ?, ?)",
        );
        for (const order of orders) {
          if (order.quantity > 0) {
            insert.run(
              integration.userId,
              order.transactionKey!,
              legacy.bucket_name,
            );
          }
        }
        database.prepare(
          "DELETE FROM portfolio_bucket_transactions WHERE user_id = ? AND transaction_key = ?",
        ).run(integration.userId, legacyKey);
      })();
    }
    return orders;
  })().finally(() => pending!.delete(integration.id));
  pending.set(integration.id, request);
  return request;
}

export const trading212Adapter: IntegrationAdapter = {
  fetchCashHistory: fetchTrading212CashHistory,
  async fetchPortfolio(database, integration) {
    const client = getTrading212Client(
      parseTrading212Credentials(integration.credentials),
    );
    const [positions, cfdOrders] = await Promise.all([
      client.get<Trading212Position[]>("/api/v0/equity/positions"),
      fetchCfdOrders(database, integration),
    ]);
    if (!Array.isArray(positions)) {
      throw new Error("Invalid Trading 212 portfolio response");
    }
    return [
      ...positions.flatMap((position) => {
        const mapped = toTrading212Position(integration, position);
        return mapped ? [mapped] : [];
      }),
      ...buildCfdPositions(cfdOrders),
    ];
  },
  fetchOrderHistory(database, integration) {
    let pending = pendingHistory.get(database);
    if (!pending) {
      pending = new Map();
      pendingHistory.set(database, pending);
    }
    const existing = pending.get(integration.id);
    if (existing) return existing;
    const request = Promise.all([
      syncHistory(database, integration),
      fetchCfdOrders(database, integration),
    ]).then(([orders, cfd]) =>
      [...orders, ...cfd].sort((a, b) => +a.date - +b.date)
    ).finally(() => pending!.delete(integration.id));
    pending.set(integration.id, request);
    return request;
  },
  async probe(integration) {
    const client = getTrading212Client(
      parseTrading212Credentials(integration.credentials),
    );
    await client.get("/api/v0/equity/positions");
  },
};
