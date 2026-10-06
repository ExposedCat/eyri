import type { Database } from "../../database/setup.ts";
import type { Integration } from "../../database/integration.ts";
import type { IntegrationCashTransaction } from "../types.ts";
import {
  getTrading212Client,
  type Trading212Transaction,
  type Trading212TransactionPage,
} from "./api.ts";
import { parseTrading212Credentials } from "./credentials.ts";

const PATH = "/api/v0/equity/history/transactions";
const pending = new WeakMap<
  Database,
  Map<number, Promise<IntegrationCashTransaction[]>>
>();

export function toCashTransaction(
  integration: Integration,
  item: Trading212Transaction,
): IntegrationCashTransaction {
  const date = new Date(item.dateTime);
  if (
    typeof item.reference !== "string" || !item.reference.trim() ||
    typeof item.currency !== "string" || !item.currency.trim() ||
    typeof item.type !== "string" || !item.type.trim() ||
    typeof item.dateTime !== "string" ||
    typeof item.amount !== "number" || !Number.isFinite(item.amount) ||
    !Number.isFinite(+date)
  ) {
    throw new Error("Invalid Trading 212 cash transaction");
  }
  return {
    integrationId: integration.id,
    reference: item.reference,
    date,
    amount: item.amount,
    currency: item.currency.trim().toUpperCase(),
    type: item.type,
  };
}

async function sync(database: Database, integration: Integration) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS trading212_transactions (
      integration_id INTEGER NOT NULL REFERENCES integrations(id) ON DELETE CASCADE,
      reference TEXT NOT NULL,
      payload TEXT NOT NULL,
      PRIMARY KEY (integration_id, reference)
    );
    CREATE TABLE IF NOT EXISTS trading212_transaction_sync (
      integration_id INTEGER PRIMARY KEY REFERENCES integrations(id) ON DELETE CASCADE,
      synced_at REAL NOT NULL
    );
  `);
  const read = () =>
    database.prepare(
      "SELECT payload FROM trading212_transactions WHERE integration_id = ?",
    ).all(integration.id).map((row) =>
      toCashTransaction(integration, JSON.parse(row.payload as string))
    )
      .sort((a, b) => +a.date - +b.date);
  const state = database.prepare(
    "SELECT synced_at FROM trading212_transaction_sync WHERE integration_id = ?",
  ).get(integration.id) as { synced_at: number } | undefined;
  if (state && Date.now() - state.synced_at < 60_000) return read();
  const known = new Set(
    database.prepare(
      "SELECT reference FROM trading212_transactions WHERE integration_id = ?",
    ).all(integration.id).map((row) => row.reference as string),
  );
  const client = getTrading212Client(
    parseTrading212Credentials(integration.credentials),
  );
  const visited = new Set<string>();
  const fetched = new Map<string, Trading212Transaction>();
  let path: string | null = `${PATH}?limit=50`;
  while (path) {
    if (!path.startsWith(`${PATH}?`) || visited.has(path)) {
      throw new Error("Invalid Trading 212 transaction pagination");
    }
    visited.add(path);
    const page: Trading212TransactionPage = await client.get(path);
    if (
      !Array.isArray(page.items) ||
      (page.nextPagePath !== null &&
        (typeof page.nextPagePath !== "string" ||
          !page.nextPagePath.startsWith(`${PATH}?`)))
    ) {
      throw new Error("Invalid Trading 212 transaction history response");
    }
    for (const item of page.items) {
      toCashTransaction(integration, item);
      fetched.set(item.reference, item);
    }
    // Interrupted first imports must traverse all pages again before reporting a total.
    if (
      state && page.items.length > 0 &&
      page.items.every((item) => known.has(item.reference))
    ) break;
    path = page.nextPagePath;
  }
  database.transaction(() => {
    for (const item of fetched.values()) {
      database.prepare(`
        INSERT INTO trading212_transactions (integration_id, reference, payload) VALUES (?, ?, ?)
        ON CONFLICT(integration_id, reference) DO UPDATE SET payload = excluded.payload
      `).run(integration.id, item.reference, JSON.stringify(item));
    }
    database.prepare(`
      INSERT INTO trading212_transaction_sync (integration_id, synced_at) VALUES (?, ?)
      ON CONFLICT(integration_id) DO UPDATE SET synced_at = excluded.synced_at
    `).run(integration.id, Date.now());
  })();
  return read();
}

export function fetchTrading212CashHistory(
  database: Database,
  integration: Integration,
) {
  let requests = pending.get(database);
  if (!requests) {
    requests = new Map();
    pending.set(database, requests);
  }
  const existing = requests.get(integration.id);
  if (existing) return existing;
  const request = sync(database, integration).finally(() =>
    requests!.delete(integration.id)
  );
  requests.set(integration.id, request);
  return request;
}
