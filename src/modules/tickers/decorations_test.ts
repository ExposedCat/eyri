import { deepStrictEqual, equal } from "node:assert/strict";
import { Database } from "@db/sqlite";
import { Bot } from "grammy";
import type { CustomContext } from "../bot/types.ts";
import { tickersComposer } from "./composer.ts";
import { getDatabase } from "../storage/sqlite.ts";
import {
  ensureTickerDisplaySchema,
  formatDecoratedTicker,
  readTickerDecorations,
  readTickerEmojiMappings,
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
      CREATE TABLE ticker_label_links (
        user_id TEXT NOT NULL, ticker TEXT NOT NULL, tag TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY(user_id,ticker)
      );
      INSERT INTO ticker_label_links(user_id,ticker,tag,updated_at) VALUES
        ('1','SMH','SMH:LON','2026-07-01'),
        ('2','SMH','SMH:AMS','2026-06-01');
    `);
    const labels = db.prepare("SELECT * FROM ticker_label_preferences").all();
    const links = db.prepare("SELECT * FROM ticker_label_links").all();
    ensureTickerDisplaySchema(db);
    deepStrictEqual(
      db
        .prepare(
          "SELECT ticker,emoji_index,tg_emoji FROM ticker_decorations ORDER BY ticker,emoji_index",
        )
        .all(),
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
    deepStrictEqual(
      db.prepare("SELECT * FROM ticker_label_links").all(),
      links,
    );
    deepStrictEqual(
      db
        .prepare(
          "SELECT ticker, preference, value FROM ticker_display_defaults ORDER BY ticker, preference",
        )
        .all(),
      [
        { ticker: "SMH", preference: "label", value: "false" },
        { ticker: "SMH", preference: "link", value: "SMH:LON" },
      ],
    );
    const icons = db.prepare("SELECT * FROM ticker_decorations").all();
    db.prepare(
      "UPDATE ticker_label_preferences SET label = 'New personal value' WHERE user_id = '2'",
    ).run();
    ensureTickerDisplaySchema(db);
    deepStrictEqual(
      db.prepare("SELECT * FROM ticker_decorations").all(),
      icons,
    );
    equal(
      db
        .prepare(
          "SELECT value FROM ticker_display_defaults WHERE preference = 'label'",
        )
        .value(),
      "false",
    );
    equal(
      db
        .prepare(
          "SELECT name FROM pragma_table_info('ticker_decorations') WHERE name='user_id'",
        )
        .get(),
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
      db
        .prepare(
          "SELECT ticker,emoji_index,emoji_text,is_custom_emoji FROM ticker_decorations",
        )
        .all(),
      [{ ticker: "SMH", emoji_index: 0, emoji_text: "🌱", is_custom_emoji: 0 }],
    );
  } finally {
    db.close();
  }
});

Deno.test("ticker display defaults are shared until a user overrides them", async () => {
  const directory = await Deno.makeTempDir();
  const previous = Deno.env.get("EYRI_DATABASE_PATH");
  Deno.env.set("EYRI_DATABASE_PATH", `${directory}/test.sqlite`);
  try {
    const globalIcons = [
      { tgEmoji: "🌱", text: "🌱", isCustomEmoji: false },
      { tgEmoji: "42", text: "💰", isCustomEmoji: true },
    ];
    equal(await setTickerDecoration(1, " smh ", globalIcons), "global");
    equal(await setTickerLabelPreference(1, " smh ", "Our fund"), "global");
    equal(await setTickerLabelLink(1, " smh ", "SMH:LON"), "global");
    for (const userId of [1, 2, 3]) {
      deepStrictEqual((await readTickerDecorations(userId)).SMH, globalIcons);
      deepStrictEqual(await readTickerLabelPreferences(userId), {
        SMH: "Our fund",
      });
      deepStrictEqual(await readTickerLabelLinks(userId), { SMH: "SMH:LON" });
    }

    equal(await setTickerLabelPreference(1, "SMH", "My fund"), "personal");
    equal(await setTickerLabelPreference(2, "SMH", false), "personal");
    equal(await setTickerLabelLink(1, "SMH", "SMH:AMS"), "personal");
    const personalIcons = [{ tgEmoji: "✨", text: "✨", isCustomEmoji: false }];
    equal(await setTickerDecoration(2, "SMH", personalIcons), "personal");
    const render = async (ticker: string, userId: number) =>
      formatDecoratedTicker(
        ticker,
        await readTickerDecorations(userId),
        await readTickerLabelPreferences(userId),
        await readTickerLabelLinks(userId),
        await readTickerEmojiMappings(),
      );
    equal(
      await render("SMH", 1),
      '🌱<tg-emoji emoji-id="42">💰</tg-emoji> <a href="https://www.google.com/finance/beta/quote/SMH:AMS">My fund</a>',
    );
    equal(await render("SMH", 2), "✨");
    equal(
      await render("SMH", 3),
      '🌱<tg-emoji emoji-id="42">💰</tg-emoji> <a href="https://www.google.com/finance/beta/quote/SMH:LON">Our fund</a>',
    );

    // Replacing an override replaces its complete set and leaves the default intact.
    equal(await setTickerDecoration(2, "SMH", globalIcons), "personal");
    equal(await setTickerDecoration(2, "SMH", personalIcons), "personal");
    deepStrictEqual((await readTickerDecorations(2)).SMH, personalIcons);
    deepStrictEqual((await readTickerDecorations(1)).SMH, globalIcons);
    deepStrictEqual((await readTickerDecorations(3)).SMH, globalIcons);
    equal(await setTickerDecoration(1, "SMH", personalIcons), "personal");
    deepStrictEqual((await readTickerDecorations(1)).SMH, personalIcons);
    deepStrictEqual((await readTickerDecorations(3)).SMH, globalIcons);

    // Removing a link must suppress both an inherited link and the .US automatic link.
    equal(await setTickerLabelLink(3, "SMH", false), "personal");
    equal(
      await render("SMH", 3),
      '🌱<tg-emoji emoji-id="42">💰</tg-emoji> Our fund',
    );
    equal(await setTickerLabelLink(1, "MU.US", "MU:NYSE"), "global");
    equal(await setTickerLabelLink(2, "MU.US", false), "personal");
    equal(await render("MU.US", 2), "MU.US");
    equal(
      await render("MU.US", 3),
      '<a href="https://www.google.com/finance/beta/quote/MU:NYSE">MU.US</a>',
    );
    equal(await setTickerLabelLink(2, "MU.US", "MU:NASDAQ"), "personal");
    equal(
      await render("MU.US", 2),
      '<a href="https://www.google.com/finance/beta/quote/MU:NASDAQ">MU.US</a>',
    );

    // Explicit false is itself a global value, so later writes become overrides.
    equal(await setTickerLabelPreference(1, "HIDE", false), "global");
    equal(await setTickerLabelPreference(2, "HIDE", "Visible"), "personal");
    equal(await render("HIDE", 2), "Visible");
    equal(await render("HIDE", 3), "");
    equal(await setTickerLabelLink(1, "NONE.US", false), "global");
    equal(await render("NONE.US", 3), "NONE.US");
    equal(await setTickerLabelLink(2, "NONE.US", "NONE:NYSE"), "personal");
    equal(
      await render("NONE.US", 2),
      '<a href="https://www.google.com/finance/beta/quote/NONE:NYSE">NONE.US</a>',
    );

    const db = await getDatabase();
    db.prepare(`
      INSERT INTO ticker_emoji_mappings (ticker, pack_name, custom_emoji_id, emoji_text)
      VALUES ('PACK', 'test_pack', '99', '💰')
    `).run();
    equal(await setTickerDecoration(2, "PACK", personalIcons), "personal");
    equal(await render("PACK", 2), "✨ PACK");
    equal(
      await render("PACK", 3),
      '<tg-emoji emoji-id="99">💰</tg-emoji> PACK',
    );
    const defaults = db
      .prepare(
        "SELECT * FROM ticker_display_defaults ORDER BY ticker, preference",
      )
      .all();
    ensureTickerDisplaySchema(db);
    deepStrictEqual(
      db
        .prepare(
          "SELECT * FROM ticker_display_defaults ORDER BY ticker, preference",
        )
        .all(),
      defaults,
    );

    // Exercise Telegram command routing and the scope shown in replies.
    const replies: string[] = [];
    const bot = new Bot<CustomContext>("123:test", {
      botInfo: {
        id: 123,
        is_bot: true,
        first_name: "Eyri",
        username: "eyri_bot",
        can_join_groups: true,
        can_read_all_group_messages: false,
        supports_inline_queries: false,
        can_connect_to_business: false,
        has_main_web_app: false,
      },
    });
    bot.api.config.use((_previous, _method, payload) => {
      replies.push(String((payload as { text?: string }).text));
      return Promise.resolve({ ok: true, result: {} }) as never;
    });
    bot.use(tickersComposer);
    let updateId = 0;
    async function command(text: string, userId: number) {
      await bot.handleUpdate({
        update_id: ++updateId,
        message: {
          message_id: updateId,
          date: 1,
          chat: { id: userId, type: "private", first_name: "User" },
          from: { id: userId, is_bot: false, first_name: "User" },
          text,
          entities: [
            {
              type: "bot_command",
              offset: 0,
              length: text.split(" ")[0].length,
            },
          ],
        },
      });
    }
    for (const [name, original, override] of [
      ["decorate", "🌱 💰", "✨"],
      ["label", "Shared", "Personal"],
      ["link", "CMD:NYSE", "false"],
    ]) {
      await command(`/${name} CMD ${original}`, 1);
      equal(replies.at(-1)?.includes("for everyone"), true);
      await command(`/${name} CMD ${override}`, 2);
      equal(replies.at(-1)?.includes("for you"), true);
    }
    equal(await render("CMD", 2), "✨ Personal");
    equal(
      await render("CMD", 3),
      '🌱💰 <a href="https://www.google.com/finance/beta/quote/CMD:NYSE">Shared</a>',
    );
  } finally {
    (await getDatabase()).close();
    if (previous === undefined) Deno.env.delete("EYRI_DATABASE_PATH");
    else Deno.env.set("EYRI_DATABASE_PATH", previous);
    await Deno.remove(directory, { recursive: true });
  }
});
