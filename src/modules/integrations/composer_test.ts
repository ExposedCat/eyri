import { deepStrictEqual, equal, match, ok } from "node:assert/strict";
import { Database } from "@db/sqlite";
import { Bot } from "grammy";
import type { Update } from "grammy_types";
import type { CustomContext } from "../bot/types.ts";
import { createReplyWithTextFunc } from "../bot/utils.ts";
import { ensureSchema } from "../database/setup.ts";
import {
  getIntegrationSetup,
  getUserIntegrations,
} from "../database/integration.ts";
import { integrationsComposer } from "./composer.ts";
import type { RichMessage } from "../bot/rich.ts";

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
  let messageId = 100;
  bot.api.config.use((_previous, method, payload) => {
    calls.push({
      method,
      payload: payload as unknown as Record<string, unknown>,
    });
    const chatId = (payload as { chat_id?: number }).chat_id ?? 1;
    return Promise.resolve({
      ok: true,
      result: method === "answerCallbackQuery" ? true : {
        message_id: ++messageId,
        date: 1,
        chat: { id: chatId, type: "private" },
        text: "mock",
      },
    }) as never;
  });
  bot.use(async (ctx, next) => {
    ctx.db = db;
    ctx.dbEntities = { user: { userId: ctx.from!.id } };
    ctx.text = createReplyWithTextFunc(ctx);
    await next();
  });
  bot.use(integrationsComposer);
  let updateId = 0;
  return {
    calls,
    async text(text: string, userId = 1, chatId = 1, replyId?: number) {
      await bot.handleUpdate({
        update_id: ++updateId,
        message: {
          message_id: updateId,
          date: 1,
          chat: { id: chatId, type: "private" },
          from: {
            id: userId,
            is_bot: false,
            first_name: "User",
            language_code: "en",
          },
          text,
          ...(text.startsWith("/")
            ? {
              entities: [{
                type: "bot_command",
                offset: 0,
                length: text.split(" ")[0].length,
              }],
            }
            : {}),
          ...(replyId === undefined ? {} : {
            reply_to_message: {
              message_id: replyId,
              date: 1,
              chat: { id: chatId, type: "private" },
              text: "prompt",
            },
          }),
        },
      } as Update);
    },
    async click(data: string, userId = 1, chatId = 1) {
      await bot.handleUpdate({
        update_id: ++updateId,
        callback_query: {
          id: String(updateId),
          chat_instance: "test",
          data,
          from: {
            id: userId,
            is_bot: false,
            first_name: "User",
            language_code: "en",
          },
          message: {
            message_id: 50,
            date: 1,
            chat: { id: chatId, type: "private" },
            text: "menu",
          },
        },
      } as Update);
    },
  };
}

function richMessage(calls: ReturnType<typeof harness>["calls"]) {
  return calls.filter((call) =>
    call.method === "sendRichMessage" || call.method === "editMessageText"
  ).at(-1)!.payload.rich_message as RichMessage;
}

Deno.test("rich integration menu adds multiple accounts, persists selection and deletes individual rows", async () => {
  const db = new Database(":memory:");
  try {
    ensureSchema(db);
    db.exec("INSERT INTO users (user_id) VALUES (1), (2)");
    let app = harness(db);
    await app.text("/integrations");
    equal(app.calls.at(-1)?.method, "sendRichMessage");
    deepStrictEqual(richMessage(app.calls).blocks.at(-1), {
      type: "buttons",
      buttons: [{
        text: "Add integration",
        style: "primary",
        callback_data: "integration:1:add",
      }],
    });
    await app.click("integration:1:add");
    equal(app.calls.at(-1)?.method, "editMessageText");
    match(
      JSON.stringify(richMessage(app.calls)),
      /Freedom24.*select:f24.*IBKR.*select:ibkr/,
    );
    await app.click("integration:1:select:f24");
    equal(getIntegrationSetup(db, 1, 1)?.kind, "f24");
    match(
      String(app.calls.at(-1)?.payload.text),
      /\[api_key\] \[secret_key\] \[history_years\]/,
    );
    await app.text("invalid");
    equal(getUserIntegrations(db, 1).length, 0);
    ok(getIntegrationSetup(db, 1, 1));
    // Recreating the bot simulates a restart during credential entry.
    app = harness(db);
    await app.text("APIKEYONE SECRETKEY");
    equal(getIntegrationSetup(db, 1, 1), undefined);
    deepStrictEqual(getUserIntegrations(db, 1)[0].credentials, {
      apiKey: "APIKEYONE",
      secretKey: "SECRETKEY",
      historyYears: 10,
    });
    await app.text("/f24 APIKEYTWO OTHERSECRET 3");
    await app.text("/ibkr gateway-one:4003 TOKEN1 QUERY1");
    await app.click("integration:1:select:ibkr");
    await app.text("gateway-two:4003 TOKEN2 QUERY2");
    deepStrictEqual(getUserIntegrations(db, 1).map((item) => item.kind), [
      "f24",
      "f24",
      "ibkr",
      "ibkr",
    ]);
    const menu = richMessage(app.calls);
    const row = menu.blocks[1];
    ok(row.type === "paragraph" && Array.isArray(row.text));
    const button = row.text[1];
    ok(typeof button === "object");
    deepStrictEqual(button.button, {
      text: "Delete",
      style: "danger",
      callback_data: "integration:1:delete:1",
    });
    ok(!JSON.stringify(menu).includes("SECRETKEY"));
    ok(!JSON.stringify(menu).includes("TOKEN1"));
    await app.click("integration:1:delete:1", 2);
    equal(getUserIntegrations(db, 1).length, 4);
    await app.click("integration:2:delete:1", 2);
    equal(getUserIntegrations(db, 1).length, 4);
    await app.click("integration:1:delete:1");
    deepStrictEqual(getUserIntegrations(db, 1).map((item) => item.id), [
      2,
      3,
      4,
    ]);
    equal(app.calls.at(-1)?.method, "editMessageText");
    const firstRemainingRow = richMessage(app.calls).blocks[1];
    ok(
      firstRemainingRow.type === "paragraph" &&
        Array.isArray(firstRemainingRow.text),
    );
    match(String(firstRemainingRow.text[0]), /^1\. Freedom24 /);
    const remainingDelete = firstRemainingRow.text[1];
    ok(typeof remainingDelete === "object");
    equal(remainingDelete.button.callback_data, "integration:1:delete:2");
    // A duplicate click is answered without trying an identical edit.
    await app.click("integration:1:delete:1");
    equal(app.calls.at(-1)?.method, "answerCallbackQuery");
  } finally {
    db.close();
  }
});

Deno.test("credential flow ignores other users, chats, old replies and commands; cancel clears it", async () => {
  const db = new Database(":memory:");
  try {
    ensureSchema(db);
    db.exec("INSERT INTO users (user_id) VALUES (1), (2)");
    const app = harness(db);
    await app.click("integration:1:select:f24");
    await app.text("KEY SECRET", 2);
    await app.text("KEY SECRET", 1, 2);
    await app.text("KEY SECRET", 1, 1, 999);
    await app.text("/perf");
    equal(getUserIntegrations(db, 1).length, 0);
    equal(getUserIntegrations(db, 2).length, 0);
    ok(getIntegrationSetup(db, 1, 1));
    await app.text("KEY SECRET -1");
    equal(getUserIntegrations(db, 1).length, 0);
    await app.text("/cancel");
    equal(getIntegrationSetup(db, 1, 1), undefined);
    await app.text("KEY SECRET");
    equal(getUserIntegrations(db, 1).length, 0);
    await app.text("/f24 ONE SECRET");
    await app.text("/f24 TWO SECRET");
    await app.text("/integration_delete f24");
    equal(getUserIntegrations(db, 1).length, 2);
    await app.text("/integration_delete 1");
    deepStrictEqual(getUserIntegrations(db, 1).map((item) => item.id), [2]);
    await app.text("/integration_delete 1");
    equal(getUserIntegrations(db, 1).length, 0);
  } finally {
    db.close();
  }
});

Deno.test("Trading 212 command and provider button save live/demo accounts and mask credentials", async () => {
  const db = new Database(":memory:");
  try {
    ensureSchema(db);
    db.exec("INSERT INTO users (user_id) VALUES (1), (2)");
    let app = harness(db);
    await app.text("/t212");
    match(
      String(app.calls.at(-1)?.payload.text),
      /\/t212.*\[api_key\].*\[secret_key\]/s,
    );
    await app.text("/t212 KEY SECRET production");
    await app.text("/t212 KEY");
    equal(getUserIntegrations(db, 1).length, 0);
    await app.text("/t212 LIVEKEYONE LIVESECRET");
    deepStrictEqual(getUserIntegrations(db, 1)[0].credentials, {
      apiKey: "LIVEKEYONE",
      secretKey: "LIVESECRET",
      environment: "live",
    });
    await app.click("integration:1:add");
    match(JSON.stringify(richMessage(app.calls)), /Trading 212.*select:t212/);
    await app.click("integration:1:select:t212", 2);
    equal(getIntegrationSetup(db, 2, 1), undefined);
    await app.click("integration:1:select:t212");
    equal(getIntegrationSetup(db, 1, 1)?.kind, "t212");
    match(
      String(app.calls.at(-1)?.payload.text),
      /read-only.*trading permissions disabled/s,
    );
    app = harness(db);
    await app.text("DEMO DEMOSECRET demo");
    deepStrictEqual(getUserIntegrations(db, 1)[1].credentials, {
      apiKey: "DEMO",
      secretKey: "DEMOSECRET",
      environment: "demo",
    });
    const menu = JSON.stringify(richMessage(app.calls));
    match(menu, /Trading 212.*live.*Trading 212.*demo/);
    for (
      const credential of ["LIVEKEYONE", "LIVESECRET", "DEMOSECRET", "DEMO"]
    ) {
      ok(!menu.includes(credential));
    }
    await app.text("/integration_delete 2");
    equal(getUserIntegrations(db, 1).length, 1);
    await app.text("/integration_delete t212");
    equal(getUserIntegrations(db, 1).length, 0);
  } finally {
    db.close();
  }
});
