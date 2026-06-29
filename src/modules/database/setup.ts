import type { Database } from "@db/sqlite";
import { getDatabase } from "../storage/sqlite.ts";

export type { Database };

function ensureSchema(database: Database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS users (
      user_id INTEGER PRIMARY KEY,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS integrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      kind TEXT NOT NULL,
      credentials_json TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(user_id),
      UNIQUE (user_id, kind)
    );

    CREATE INDEX IF NOT EXISTS integrations_user_id_idx
      ON integrations(user_id);

    CREATE TABLE IF NOT EXISTS portfolio_buckets (
      user_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (user_id, name),
      FOREIGN KEY (user_id) REFERENCES users(user_id)
    );

    CREATE TABLE IF NOT EXISTS portfolio_bucket_transactions (
      user_id INTEGER NOT NULL,
      transaction_key TEXT NOT NULL,
      bucket_name TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (user_id, transaction_key),
      FOREIGN KEY (user_id) REFERENCES users(user_id),
      FOREIGN KEY (user_id, bucket_name)
        REFERENCES portfolio_buckets(user_id, name)
        ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS portfolio_bucket_transactions_bucket_idx
      ON portfolio_bucket_transactions(user_id, bucket_name);
  `);
}

export async function connectToDb() {
  const database = await getDatabase();
  ensureSchema(database);
  return database;
}
