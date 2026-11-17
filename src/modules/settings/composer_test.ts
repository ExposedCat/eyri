import { deepStrictEqual, equal, match } from "node:assert/strict";
import { Database } from "@db/sqlite";
import { Bot } from "grammy";
import type { CustomContext } from "../bot/types.ts";
import { ensureSchema } from "../database/setup.ts";
import { findOrCreateUser } from "../database/user.ts";
import { portfolioVisibility } from "../database/visibility.ts";
import { settingsComposer } from "./composer.ts";

function harness(db: Database) {
  const calls: { method: string; payload: Record<string, unknown> }[] = [];
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
  bot.api.config.use((_previous, method, payload) => {
    calls.push({
      method,
      payload: payload as unknown as Record<string, unknown>,
    });
    return Promise.resolve({ ok: true, result: { message_id: 100 } }) as never;
  });
  bot.use(async (ctx, next) => {
    ctx.db = db;
    ctx.dbEntities = { user: await findOrCreateUser(db, ctx.from!.id) };
    await next();
  });
  bot.use(settingsComposer);
  let id = 0;
  const chat = (chatId: number) =>
    chatId < 0
      ? { id: chatId, type: "supergroup" as const, title: "Group" }
      : { id: chatId, type: "private" as const, first_name: "User" };
  const from = (userId: number) => ({
    id: userId,
    first_name: "User",
    is_bot: false,
  });
  return {
    calls,
    command: (chatId = -1, ephemeral = false) =>
      bot.handleUpdate({
        update_id: ++id,
        message: {
          message_id: ephemeral ? 0 : id,
          date: 1,
          chat: chat(chatId),
          from: from(1),
          ...(ephemeral ? { ephemeral_message_id: 17 } : {}),
          text: "/settings",
          entities: [{ type: "bot_command", offset: 0, length: 9 }],
        },
      }),
    click: (data: string, userId = 1, chatId = -1, ephemeral = true) =>
      bot.handleUpdate({
        update_id: ++id,
        callback_query: {
          id: `callback${id}`,
          from: from(userId),
          chat_instance: "one",
          data,
          message: {
            message_id: ephemeral ? 0 : 100,
            date: 1,
            chat: chat(chatId),
            ...(ephemeral ? { ephemeral_message_id: 18 } : {}),
          },
        },
      }),
  };
}

Deno.test("settings are ephemeral in groups, default Public with inline green toggles, and edit in place", async () => {
  const db = new Database(":memory:");
  try {
    ensureSchema(db);
    const h = harness(db);
    await h.command(-1, true);
    equal(h.calls[0].method, "sendRichMessage");
    deepStrictEqual(h.calls[0].payload.ephemeral_message_parameters, {
      receiver_user_id: 1,
    });
    deepStrictEqual(h.calls[0].payload.reply_parameters, {
      ephemeral_message_id: 17,
    });
    const html = (h.calls[0].payload.rich_message as { html: string }).html;
    equal((html.match(/style="success"/g) ?? []).length, 2);
    match(html, /Visibility <tg-button/);
    match(html, /Chat visibility <tg-button/);
    await h.click("visibility:1:chat:-1");
    equal(portfolioVisibility(db, 1), true);
    equal(portfolioVisibility(db, 1, -1), false);
    equal(portfolioVisibility(db, 1, -2), true);
    const edit = h.calls.find((call) =>
      call.method === "editEphemeralMessageText"
    )!;
    equal(edit.payload.ephemeral_message_id, 18);
    equal(edit.payload.receiver_user_id, 1);
    equal(edit.payload.message_id, undefined);
    match(
      (edit.payload.rich_message as { html: string }).html,
      /Chat visibility <tg-button[^>]*style="danger"[^>]*>Private/,
    );
    await h.click("visibility:1:chat:-1");
    equal(portfolioVisibility(db, 1, -1), true);
    const restarted = harness(db);
    await restarted.click("visibility:1:global:-1");
    equal(portfolioVisibility(db, 1), false);
    equal(portfolioVisibility(db, 1, -2), false);
    equal(portfolioVisibility(db, 1, -1), true);
    await restarted.command(1);
    equal(
      restarted.calls.at(-1)!.payload.ephemeral_message_parameters,
      undefined,
    );
    await restarted.click("visibility:1:chat:1", 1, 1, false);
    equal(restarted.calls.at(-2)!.method, "editMessageText");
  } finally {
    db.close();
  }
});

Deno.test("settings buttons reject other users and copied menus from another chat", async () => {
  const db = new Database(":memory:");
  try {
    ensureSchema(db);
    const h = harness(db);
    await h.command();
    await h.click("visibility:1:global:-1", 2);
    await h.click("visibility:1:global:-1", 1, -2);
    equal(portfolioVisibility(db, 1), true);
    equal(portfolioVisibility(db, 2), true);
    deepStrictEqual(h.calls.slice(1).map((call) => call.method), [
      "answerCallbackQuery",
      "answerCallbackQuery",
    ]);
  } finally {
    db.close();
  }
});
