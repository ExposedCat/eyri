import type { Database } from "@db/sqlite";
import { getDatabase } from "../storage/sqlite.ts";

export type { Database };

export function ensureSchema(database: Database) {
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
      FOREIGN KEY (user_id) REFERENCES users(user_id)
    );

    CREATE INDEX IF NOT EXISTS integrations_user_id_idx
      ON integrations(user_id);

    CREATE TABLE IF NOT EXISTS integration_setup_sessions (
      user_id INTEGER NOT NULL REFERENCES users(user_id),
      chat_id INTEGER NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('ibkr', 'f24', 't212')),
      prompt_message_id INTEGER NOT NULL,
      PRIMARY KEY (user_id, chat_id)
    );

    CREATE TABLE IF NOT EXISTS rsu_awards (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(user_id),
      ticker TEXT NOT NULL,
      amount REAL NOT NULL CHECK (amount > 0),
      price REAL NOT NULL CHECK (price > 0),
      award_date TEXT NOT NULL,
      vesting_json TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS rsu_awards_user_id_idx
      ON rsu_awards(user_id);

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

    CREATE TABLE IF NOT EXISTS portfolio_bucket_access (
      user_id INTEGER NOT NULL REFERENCES users(user_id),
      bucket_name TEXT NOT NULL,
      owner_user_id INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (user_id, bucket_name),
      FOREIGN KEY (owner_user_id, bucket_name)
        REFERENCES portfolio_buckets(user_id, name) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS portfolio_bucket_inclusions (
      user_id INTEGER NOT NULL REFERENCES users(user_id),
      bucket_name TEXT NOT NULL,
      owner_user_id INTEGER NOT NULL,
      PRIMARY KEY (user_id, bucket_name),
      FOREIGN KEY (owner_user_id, bucket_name)
        REFERENCES portfolio_buckets(user_id, name) ON DELETE CASCADE
    );
  `);
  const userColumns = database.prepare("PRAGMA table_info(users)").all() as { name: string }[];
  if (!userColumns.some((column) => column.name === "currency")) {
    database.exec("ALTER TABLE users ADD COLUMN currency TEXT");
  }
  migrateIntegrations(database);
  migrateIntegrationSetup(database);
}

function migrateIntegrationSetup(database: Database) {
  const table = database.prepare(
    "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'integration_setup_sessions'",
  ).get() as { sql: string };
  if (table.sql.includes("'t212'")) return;
  database.transaction(() => {
    database.exec(`
      CREATE TABLE integration_setup_sessions_new (
        user_id INTEGER NOT NULL REFERENCES users(user_id),
        chat_id INTEGER NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('ibkr', 'f24', 't212')),
        prompt_message_id INTEGER NOT NULL,
        PRIMARY KEY (user_id, chat_id)
      );
      INSERT INTO integration_setup_sessions_new SELECT * FROM integration_setup_sessions;
      DROP TABLE integration_setup_sessions;
      ALTER TABLE integration_setup_sessions_new RENAME TO integration_setup_sessions;
    `);
  })();
}

function migrateIntegrations(database: Database) {
  const indexes = database.prepare("PRAGMA index_list(integrations)").all() as {
    name: string;
    unique: number;
  }[];
  const hasProviderConstraint = indexes.some((index) => {
    if (!index.unique) return false;
    const columns = database.prepare("SELECT name FROM pragma_index_info(?)")
      .all(index.name) as { name: string }[];
    return columns.length === 2 && columns[0].name === "user_id" &&
      columns[1].name === "kind";
  });
  if (!hasProviderConstraint) return;

  database.transaction(() => {
    const sequence = database.prepare(
      "SELECT seq FROM sqlite_sequence WHERE name = 'integrations'",
    ).get() as { seq: number } | undefined;
    database.exec(`
      CREATE TABLE integrations_multiple (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL REFERENCES users(user_id),
        kind TEXT NOT NULL,
        credentials_json TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      INSERT INTO integrations_multiple
        SELECT id, user_id, kind, credentials_json, created_at, updated_at
        FROM integrations;
      DROP TABLE integrations;
      ALTER TABLE integrations_multiple RENAME TO integrations;
      CREATE INDEX integrations_user_id_idx ON integrations(user_id);
    `);
    // Never reuse a deleted ID: broker history and old buttons refer to it.
    if (sequence) {
      database.prepare(
        "UPDATE sqlite_sequence SET seq = MAX(seq, ?) WHERE name = 'integrations'",
      ).run(sequence.seq);
    }
  })();
}

export async function connectToDb() {
  const database = await getDatabase();
  ensureSchema(database);
  return database;
}
