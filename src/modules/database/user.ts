import type { Database } from "./setup.ts";

export type User = {
  userId: number;
};

type UserRow = {
  user_id: number;
};

function readUser(database: Database, userId: number): User | null {
  const row = database
    .prepare("SELECT user_id FROM users WHERE user_id = ?")
    .get(userId) as UserRow | undefined;

  if (!row) {
    return null;
  }

  return {
    userId: row.user_id,
  };
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
