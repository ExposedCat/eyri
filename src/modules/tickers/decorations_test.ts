import { deepStrictEqual, equal } from "node:assert/strict";
import { Database } from "@db/sqlite";
import { getDatabase } from "../storage/sqlite.ts";
import {
  ensureTickerDisplaySchema,
  formatDecoratedTicker,
  readTickerDecorations,
  readTickerLabelLinks,
  readTickerLabelPreferences,
  setTickerDecoration,
  setTickerLabelLink,
  setTickerLabelPreference,
} from "./decorations.ts";

function legacyIcons(db: Database, indexed = true) {
  db.exec(`CREATE TABLE ticker_decorations (
    user_id TEXT NOT NULL, ticker TEXT NOT NULL,
    ${indexed ? "emoji_index INTEGER NOT NULL," : ""}
    tg_emoji TEXT NOT NULL, emoji_text TEXT NOT NULL,
    is_custom_emoji INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id, ticker${indexed ? ", emoji_index" : ""})
  )`);
}

Deno.test("global icon migration preserves the newest complete set and personal labels", () => {
  const db = new Database(":memory:");
  try {
    legacyIcons(db);
    db.exec(`
      INSERT INTO ticker_decorations(user_id,ticker,emoji_index,tg_emoji,emoji_text,updated_at) VALUES
        ('1','SMH',0,'old','A','2026-06-01'),
        ('1','SMH',1,'old2','B','2026-06-01'),
        ('2','SMH',0,'new','C','2026-07-01'),
        ('1','MU',0,'mu','D','2026-06-01'),
        ('1','SPYL',0,'tie1','E','2026-06-01'),
        ('2','SPYL',0,'tie2','F','2026-06-01');
      CREATE TABLE ticker_label_preferences (
        user_id TEXT NOT NULL, ticker TEXT NOT NULL, label TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY(user_id,ticker)
      );
      INSERT INTO ticker_label_preferences(user_id,ticker,label) VALUES
        ('1','SMH','Semiconductors'), ('2','SMH','false');
    `);
    const labels = db.prepare("SELECT * FROM ticker_label_preferences").all();
    ensureTickerDisplaySchema(db);
    deepStrictEqual(
      db.prepare(
        "SELECT ticker,emoji_index,tg_emoji FROM ticker_decorations ORDER BY ticker,emoji_index",
      ).all(),
      [
        { ticker: "MU", emoji_index: 0, tg_emoji: "mu" },
        { ticker: "SMH", emoji_index: 0, tg_emoji: "new" },
        { ticker: "SPYL", emoji_index: 0, tg_emoji: "tie2" },
      ],
    );
    deepStrictEqual(
      db.prepare("SELECT * FROM ticker_label_preferences").all(),
      labels,
    );
    const icons = db.prepare("SELECT * FROM ticker_decorations").all();
    ensureTickerDisplaySchema(db);
    deepStrictEqual(
      db.prepare("SELECT * FROM ticker_decorations").all(),
      icons,
    );
    equal(
      db.prepare(
        "SELECT name FROM pragma_table_info('ticker_decorations') WHERE name='user_id'",
      ).get(),
      undefined,
    );
  } finally {
    db.close();
  }
});

Deno.test("legacy single-icon assignments migrate to shared sets", () => {
  const db = new Database(":memory:");
  try {
    legacyIcons(db, false);
    db.exec(
      `INSERT INTO ticker_decorations(user_id,ticker,tg_emoji,emoji_text,is_custom_emoji)
      VALUES ('1','SMH','🌱','🌱',0)`,
    );
    ensureTickerDisplaySchema(db);
    deepStrictEqual(
      db.prepare(
        "SELECT ticker,emoji_index,emoji_text,is_custom_emoji FROM ticker_decorations",
      ).all(),
      [{ ticker: "SMH", emoji_index: 0, emoji_text: "🌱", is_custom_emoji: 0 }],
    );
  } finally {
    db.close();
  }
});

Deno.test("shared icons render for both users with independent labels and links", async () => {
  const directory = await Deno.makeTempDir();
  const previous = Deno.env.get("EYRI_DATABASE_PATH");
  Deno.env.set("EYRI_DATABASE_PATH", `${directory}/test.sqlite`);
  try {
    await setTickerDecoration(" smh ", [
      { tgEmoji: "🌱", text: "🌱", isCustomEmoji: false },
      { tgEmoji: "42", text: "💰", isCustomEmoji: true },
    ]);
    await setTickerLabelPreference(1, "SMH", "My fund");
    await setTickerLabelPreference(2, "SMH", false);
    await setTickerLabelLink(1, "SMH", "SMH:LON");
    const icons = await readTickerDecorations();
    equal(
      formatDecoratedTicker(
        "SMH",
        icons,
        await readTickerLabelPreferences(1),
        await readTickerLabelLinks(1),
      ),
      '🌱<tg-emoji emoji-id="42">💰</tg-emoji> <a href="https://www.google.com/finance/beta/quote/SMH:LON">My fund</a>',
    );
    equal(
      formatDecoratedTicker(
        "SMH",
        icons,
        await readTickerLabelPreferences(2),
        await readTickerLabelLinks(2),
      ),
      '🌱<tg-emoji emoji-id="42">💰</tg-emoji>',
    );
    await setTickerDecoration("SMH", [{
      tgEmoji: "✨",
      text: "✨",
      isCustomEmoji: false,
    }]);
    deepStrictEqual((await readTickerDecorations()).SMH, [{
      tgEmoji: "✨",
      text: "✨",
      isCustomEmoji: false,
    }]);
    deepStrictEqual(await readTickerLabelPreferences(1), { SMH: "My fund" });
    deepStrictEqual(await readTickerLabelPreferences(2), { SMH: false });
    deepStrictEqual(await readTickerLabelLinks(2), {});
  } finally {
    (await getDatabase()).close();
    if (previous === undefined) Deno.env.delete("EYRI_DATABASE_PATH");
    else Deno.env.set("EYRI_DATABASE_PATH", previous);
    await Deno.remove(directory, { recursive: true });
  }
});
