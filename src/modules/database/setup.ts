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
  `);
}

export async function connectToDb() {
  const database = await getDatabase();
  ensureSchema(database);
  return database;
}
