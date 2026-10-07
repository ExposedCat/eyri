import type { Database } from "../database/setup.ts";

export function ensureYahooMappings(db: Database) {
  db.transaction(() => {
    db.exec(`CREATE TABLE IF NOT EXISTS yahoo_symbol_overrides (
      ticker TEXT PRIMARY KEY, symbol TEXT NOT NULL
    )`);
    const legacy = db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'user_yahoo_symbols'",
    ).get();
    if (!legacy) return;
    // The old INSERT OR REPLACE assigns a new rowid on each save, so the
    // greatest rowid is the most recently written override for that ticker.
    db.exec(`
      WITH overrides AS (
        SELECT UPPER(TRIM(ticker)) AS ticker, UPPER(TRIM(symbol)) AS symbol,
          ROW_NUMBER() OVER (
            PARTITION BY UPPER(TRIM(ticker)) ORDER BY rowid DESC
          ) AS rank
        FROM user_yahoo_symbols
      )
      INSERT OR IGNORE INTO yahoo_symbol_overrides(ticker,symbol)
        SELECT ticker,symbol FROM overrides WHERE rank = 1;
      DROP TABLE user_yahoo_symbols;
    `);
  })();
}

export function readYahooMapping(db: Database, ticker: string) {
  ensureYahooMappings(db);
  return (db.prepare(
    "SELECT symbol FROM yahoo_symbol_overrides WHERE ticker = ?",
  ).get(ticker.trim().toUpperCase()) as
    | { symbol: string }
    | undefined)?.symbol;
}

export function saveYahooMapping(
  db: Database,
  ticker: string,
  symbol: string,
) {
  ensureYahooMappings(db);
  db.prepare(
    "INSERT OR REPLACE INTO yahoo_symbol_overrides(ticker,symbol) VALUES (?,?)",
  )
    .run(
      ticker.trim().toUpperCase(),
      symbol.trim().toUpperCase(),
    );
}

export function removeYahooMapping(
  db: Database,
  ticker: string,
) {
  ensureYahooMappings(db);
  db.prepare("DELETE FROM yahoo_symbol_overrides WHERE ticker = ?")
    .run(ticker.trim().toUpperCase());
}
