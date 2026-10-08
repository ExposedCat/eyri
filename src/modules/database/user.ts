import type { Database } from "./setup.ts";

export type User = {
  userId: number;
  currency?: string | null;
};

type UserRow = {
  user_id: number;
  currency: string | null;
};

export function readUser(database: Database, userId: number): User | null {
  const row = database
    .prepare("SELECT user_id, currency FROM users WHERE user_id = ?")
    .get(userId) as UserRow | undefined;

  if (!row) {
    return null;
  }

  return {
    userId: row.user_id,
    currency: row.currency,
  };
}

export function setUserCurrency(database: Database, userId: number, currency: string | null) {
  database.prepare("UPDATE users SET currency = ?, updated_at = CURRENT_TIMESTAMP WHERE user_id = ?")
    .run(currency, userId);
}

export async function findOrCreateUser(
  database: Database,
  userId: number,
): Promise<User | null> {
  database
    .prepare(`
      INSERT INTO users (user_id)
      VALUES (?)
      ON CONFLICT(user_id) DO UPDATE SET updated_at = CURRENT_TIMESTAMP
    `)
    .run(userId);

  return readUser(database, userId);
}
