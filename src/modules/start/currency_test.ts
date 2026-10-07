import { deepStrictEqual, equal, match } from "node:assert/strict";
import { Database } from "@db/sqlite";
import { Bot } from "grammy";
import type { CustomContext } from "../bot/types.ts";
import { ensureSchema } from "../database/setup.ts";
import { findOrCreateUser } from "../database/user.ts";
import { createCurrencyComposer } from "./currency.ts";

function harness(db: Database) {
  const replies: string[] = [];
  const requested: string[] = [];
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
    return Promise.resolve({
      ok: true,
      result: { message_id: 1, date: 1, chat: { id: 1, type: "private" } },
    }) as never;
  });
  bot.use(async (ctx, next) => {
    ctx.db = db;
    ctx.dbEntities = { user: await findOrCreateUser(db, ctx.from!.id) };
    await next();
  });
  bot.use(createCurrencyComposer(async (input) => {
    const quote = String(input).split("/").at(-1)!.toUpperCase();
    requested.push(quote);
    return quote === "BAD" || quote === "XYZ"
      ? new Response(null, { status: quote === "BAD" ? 503 : 404 })
      : Response.json({ base: "USD", quote, rate: .8 });
  }));
  let id = 0;
  return {
    replies,
    requested,
    command: (text: string, userId = 1, chatId = userId) =>
      bot.handleUpdate({
        update_id: ++id,
        message: {
          message_id: id,
          date: 1,
          chat: { id: chatId, type: "private", first_name: "User" },
          from: { id: userId, first_name: "User", is_bot: false },
          text,
          entities: [{
            type: "bot_command",
            offset: 0,
            length: text.split(" ")[0].length,
          }],
        },
      }),
  };
}

Deno.test("currency command persists per user across chats and restart, accepts provider currencies and resets to USD", async () => {
  const path = await Deno.makeTempFile();
  let db = new Database(path);
  try {
    // Exercise migration from the pre-preference schema.
    db.exec(
      "CREATE TABLE users (user_id INTEGER PRIMARY KEY, created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT DEFAULT CURRENT_TIMESTAMP); INSERT INTO users(user_id) VALUES (1)",
    );
    ensureSchema(db);
    ensureSchema(db);
    const h = harness(db);
    await h.command("/currency");
    match(h.replies.at(-1)!, /Your currency: USD/);
    await h.command("/currency eur");
    equal((await findOrCreateUser(db, 1))!.currency, "EUR");
    await h.command("/currency", 2);
    match(h.replies.at(-1)!, /Your currency: USD/);
    await h.command("/currency XYZ");
    await h.command("/currency BAD");
    await h.command("/currency EUR USD");
    equal((await findOrCreateUser(db, 1))!.currency, "EUR");
    await h.command("/currency isk", 2);
    equal((await findOrCreateUser(db, 2))!.currency, "ISK");
    await h.command("/currency gbx", 2);
    equal((await findOrCreateUser(db, 2))!.currency, "GBX");
    deepStrictEqual(h.requested, ["EUR", "XYZ", "BAD", "ISK", "GBP"]);
    db.close();
    db = new Database(path);
    ensureSchema(db);
    const restarted = harness(db);
    await restarted.command("/currency", 1, 99);
    match(restarted.replies.at(-1)!, /Your currency: EUR/);
    await restarted.command("/currency USD", 1, 99);
    equal((await findOrCreateUser(db, 1))!.currency, null);
    equal((await findOrCreateUser(db, 2))!.currency, "GBX");
    deepStrictEqual(restarted.requested, []);
  } finally {
    db.close();
    await Deno.remove(path);
  }
});
