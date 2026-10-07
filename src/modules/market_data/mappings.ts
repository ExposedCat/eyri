import type { Database } from "../database/setup.ts";

function ensureMappings(db: Database) {
  db.exec(`CREATE TABLE IF NOT EXISTS user_yahoo_symbols (
    user_id TEXT NOT NULL, ticker TEXT NOT NULL, symbol TEXT NOT NULL,
    PRIMARY KEY(user_id,ticker)
  )`);
}

export function readYahooMapping(db: Database, userId: number, ticker: string) {
  ensureMappings(db);
  return (db.prepare(
    "SELECT symbol FROM user_yahoo_symbols WHERE user_id = ? AND ticker = ?",
  ).get(String(userId), ticker.trim().toUpperCase()) as
    | { symbol: string }
    | undefined)?.symbol;
}

export function saveYahooMapping(
  db: Database,
  userId: number,
  ticker: string,
  symbol: string,
) {
  ensureMappings(db);
  db.prepare(
    "INSERT OR REPLACE INTO user_yahoo_symbols(user_id,ticker,symbol) VALUES (?,?,?)",
  )
    .run(
      String(userId),
      ticker.trim().toUpperCase(),
      symbol.trim().toUpperCase(),
    );
}

export function removeYahooMapping(
  db: Database,
  userId: number,
  ticker: string,
) {
  ensureMappings(db);
  db.prepare("DELETE FROM user_yahoo_symbols WHERE user_id = ? AND ticker = ?")
    .run(String(userId), ticker.trim().toUpperCase());
}
