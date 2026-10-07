import { deepStrictEqual, equal } from "node:assert/strict";
import { Database } from "@db/sqlite";
import {
  ensureYahooMappings,
  readYahooMapping,
  removeYahooMapping,
  saveYahooMapping,
} from "./mappings.ts";

function legacyMappings(db: Database) {
  db.exec(`CREATE TABLE user_yahoo_symbols (
    user_id TEXT NOT NULL, ticker TEXT NOT NULL, symbol TEXT NOT NULL,
    PRIMARY KEY(user_id,ticker)
  )`);
}

Deno.test("personal Yahoo overrides populate the global table with the latest saved value", () => {
  const db = new Database(":memory:");
  try {
    legacyMappings(db);
    db.exec(`INSERT INTO user_yahoo_symbols VALUES
      ('849670500','SMH','SMH.L'),
      ('1','VUAA','VUAA.DE'),
      ('2',' vuaa ',' vuaa.l '),
      ('3','MU','MU');
      INSERT OR REPLACE INTO user_yahoo_symbols VALUES ('1','VUAA','LATEST');
    `);
    ensureYahooMappings(db);
    deepStrictEqual(
      db.prepare("SELECT * FROM yahoo_symbol_overrides ORDER BY ticker").all(),
      [
        { ticker: "MU", symbol: "MU" },
        { ticker: "SMH", symbol: "SMH.L" },
        { ticker: "VUAA", symbol: "LATEST" },
      ],
    );
    equal(
      db.prepare(
        "SELECT name FROM sqlite_master WHERE name='user_yahoo_symbols'",
      ).get(),
      undefined,
    );
    equal(readYahooMapping(db, " smh "), "SMH.L");
    removeYahooMapping(db, "SMH");
    ensureYahooMappings(db);
    equal(readYahooMapping(db, "SMH"), undefined);
  } finally {
    db.close();
  }
});

Deno.test("migration preserves global overrides and leaves automatic resolutions and labels intact", () => {
  const db = new Database(":memory:");
  try {
    saveYahooMapping(db, "SMH", "SMH.L");
    legacyMappings(db);
    db.exec(`INSERT INTO user_yahoo_symbols VALUES ('1','SMH','SMH');
      CREATE TABLE yahoo_symbols (source_key TEXT PRIMARY KEY,symbol TEXT NOT NULL);
      INSERT INTO yahoo_symbols VALUES ('cached','SMH');
      CREATE TABLE ticker_label_preferences (user_id TEXT,ticker TEXT,label TEXT);
      INSERT INTO ticker_label_preferences VALUES ('1','SMH','My fund');
    `);
    ensureYahooMappings(db);
    equal(readYahooMapping(db, "SMH"), "SMH.L");
    deepStrictEqual(db.prepare("SELECT * FROM yahoo_symbols").all(), [{
      source_key: "cached",
      symbol: "SMH",
    }]);
    deepStrictEqual(
      db.prepare("SELECT * FROM ticker_label_preferences").all(),
      [{ user_id: "1", ticker: "SMH", label: "My fund" }],
    );
  } finally {
    db.close();
  }
});

Deno.test("global overrides persist across database reopen, updates normalize and resets stay removed", async () => {
  const directory = await Deno.makeTempDir();
  const path = `${directory}/mappings.sqlite`;
  let db = new Database(path);
  try {
    saveYahooMapping(db, " smh ", " smh.l ");
    db.close();
    db = new Database(path);
    equal(readYahooMapping(db, "SMH"), "SMH.L");
    saveYahooMapping(db, "SMH", "CUSTOM");
    equal(readYahooMapping(db, "SMH"), "CUSTOM");
    removeYahooMapping(db, " smh ");
    db.close();
    db = new Database(path);
    equal(readYahooMapping(db, "SMH"), undefined);
  } finally {
    db.close();
    await Deno.remove(directory, { recursive: true });
  }
});
