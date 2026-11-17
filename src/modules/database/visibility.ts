import type { Database } from "./setup.ts";

// A missing chat preference inherits the global preference (Public by default).
export function portfolioVisibility(
  db: Database,
  userId: number,
  chatId?: number,
): boolean {
  if (chatId !== undefined) {
    const row = db.prepare(
      "SELECT is_public FROM portfolio_visibility WHERE user_id = ? AND scope = ?",
    )
      .get(userId, String(chatId)) as { is_public: number } | undefined;
    if (row) return row.is_public === 1;
  }
  const row = db.prepare(
    "SELECT is_public FROM portfolio_visibility WHERE user_id = ? AND scope = 'global'",
  )
    .get(userId) as { is_public: number } | undefined;
  return row ? row.is_public === 1 : true;
}

export function setPortfolioVisibility(
  db: Database,
  userId: number,
  isPublic: boolean,
  chatId?: number,
) {
  db.prepare(
    `INSERT INTO portfolio_visibility (user_id, scope, is_public) VALUES (?, ?, ?)
    ON CONFLICT(user_id, scope) DO UPDATE SET is_public = excluded.is_public`,
  )
    .run(
      userId,
      chatId === undefined ? "global" : String(chatId),
      Number(isPublic),
    );
}
