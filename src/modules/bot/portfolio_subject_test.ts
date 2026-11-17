import { deepStrictEqual, equal } from "node:assert/strict";
import { Database } from "@db/sqlite";
import { Bot } from "grammy";
import { createIntegration } from "../database/integration.ts";
import { ensureSchema } from "../database/setup.ts";
import { findOrCreateUser } from "../database/user.ts";
import {
  portfolioVisibility,
  setPortfolioVisibility,
} from "../database/visibility.ts";
import { selectPortfolioSubject } from "./portfolio_subject.ts";
import type { CustomContext } from "./types.ts";

function harness(db: Database) {
  const selected: {
    caller: number;
    subject: number;
    currency?: string | null;
    name?: string;
  }[] = [];
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
  bot.use(async (ctx, next) => {
    ctx.db = db;
    ctx.dbEntities = { user: await findOrCreateUser(db, ctx.from!.id) };
    await next();
  });
  bot.use(selectPortfolioSubject);
  bot.use((ctx) => {
    selected.push({
      caller: ctx.from!.id,
      subject: ctx.dbEntities.user!.userId,
      currency: ctx.dbEntities.user!.currency,
      name: ctx.portfolioSubject?.first_name,
    });
  });
  let id = 0;
  return {
    selected,
    command: (
      text: string,
      replyId: number | undefined = 2,
      chatId = -1,
      botUser = false,
      anonymous = false,
    ) =>
      bot.handleUpdate({
        update_id: ++id,
        message: {
          message_id: id,
          date: 1,
          chat: { id: chatId, type: "supergroup", title: "Group" },
          from: { id: 1, first_name: "Caller", is_bot: false },
          text,
          entities: [{
            type: "bot_command",
            offset: 0,
            length: text.split(/\s/)[0].length,
          }],
          ...(replyId === undefined ? {} : {
            reply_to_message: {
              reply_to_message: undefined,
              message_id: 100,
              date: 1,
              chat: { id: chatId, type: "supergroup" as const, title: "Group" },
              from: { id: replyId, first_name: "Subject", is_bot: botUser },
              ...(anonymous
                ? {
                  sender_chat: {
                    id: -99,
                    type: "supergroup" as const,
                    title: "Anonymous",
                  },
                }
                : {}),
            },
          }),
        },
      }),
  };
}

function seed(db: Database) {
  ensureSchema(db);
  db.exec(
    "INSERT INTO users(user_id, currency) VALUES (1, 'USD'), (2, 'EUR'), (3, NULL)",
  );
  createIntegration({
    database: db,
    userId: 2,
    kind: "ibkr",
    credentials: { instanceUrl: "tcp://fixture:4003" },
  });
}

Deno.test("every portfolio report resolves replied-to public users while preserving caller identity and subject currency", async () => {
  const db = new Database(":memory:");
  try {
    seed(db);
    const h = harness(db);
    for (
      const command of [
        "portfolio",
        "chart widget options Core",
        "perf",
        "dpnl stocks",
        "alltime Core",
        "number worth options",
        "allnumber",
        "worth",
        "worthnumber",
        "sold",
        "history",
        "when AMD=100",
        "buckets",
        "rsu",
        "rsu_at 01.01.2027",
        "dump_options",
        "dump_tickers",
        "perf@eyri_bot",
      ]
    ) {
      await h.command(`/${command}`);
      deepStrictEqual(h.selected.at(-1), {
        caller: 1,
        subject: 2,
        currency: "EUR",
        name: "Subject",
      });
    }
  } finally {
    db.close();
  }
});

Deno.test("visibility is enforced on every request; chat overrides remain scoped and private users fall back to the caller", async () => {
  const db = new Database(":memory:");
  try {
    seed(db);
    const h = harness(db);
    setPortfolioVisibility(db, 2, false);
    await h.command("/perf");
    equal(h.selected.at(-1)!.subject, 1);
    setPortfolioVisibility(db, 2, true, -1);
    await h.command("/perf");
    equal(h.selected.at(-1)!.subject, 2);
    await h.command("/perf", 2, -2);
    equal(h.selected.at(-1)!.subject, 1);
    setPortfolioVisibility(db, 2, true);
    setPortfolioVisibility(db, 2, false, -1);
    await h.command("/chart");
    equal(h.selected.at(-1)!.subject, 1);
    await h.command("/chart", 2, -2);
    equal(h.selected.at(-1)!.subject, 2);
  } finally {
    db.close();
  }
});

Deno.test("unknown users, users without portfolios, bots and anonymous senders do not change the subject or create users", async () => {
  const db = new Database(":memory:");
  try {
    seed(db);
    const h = harness(db);
    await h.command("/perf", 99);
    await h.command("/perf", 3);
    await h.command("/perf", 1);
    await h.command("/perf", 2, -1, true);
    await h.command("/perf", 2, -1, false, true);
    deepStrictEqual(h.selected.map((item) => item.subject), [1, 1, 1, 1, 1]);
    equal(
      db.prepare("SELECT user_id FROM users WHERE user_id = 99").get(),
      undefined,
    );
  } finally {
    db.close();
  }
});

Deno.test("settings, credentials, transfers, RSU edits and other management commands always operate as the caller", async () => {
  const db = new Database(":memory:");
  try {
    seed(db);
    const h = harness(db);
    for (
      const command of [
        "settings",
        "currency EUR",
        "integrations",
        "ibkr credentials",
        "f24 credentials",
        "t212 credentials",
        "integration_delete 1",
        "bucket transfer Core 50%",
        "bucket move Core",
        "rsu AMD 1 100 01.01.26\n01.01.27 1",
        "rsu\tAMD",
        "rsu_rm AMD",
        "decorate AMD 🟢",
        "label AMD Name",
        "link AMD tag",
        "yahoo AMD AMD",
        "createpack",
        "syncpack",
        "removepack",
        "restart",
        "status",
        "cancel",
        "start",
      ]
    ) {
      await h.command(`/${command}`);
      equal(h.selected.at(-1)!.subject, 1, command);
    }
  } finally {
    db.close();
  }
});

Deno.test("visibility migrates existing databases and persists across database reopen", () => {
  const path = Deno.makeTempFileSync();
  let db = new Database(path);
  try {
    db.exec(
      "CREATE TABLE users (user_id INTEGER PRIMARY KEY, created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT DEFAULT CURRENT_TIMESTAMP); INSERT INTO users(user_id) VALUES (1)",
    );
    ensureSchema(db);
    equal(portfolioVisibility(db, 1), true);
    equal(portfolioVisibility(db, 1, -1), true);
    setPortfolioVisibility(db, 1, false);
    setPortfolioVisibility(db, 1, true, -1);
    db.close();
    db = new Database(path);
    ensureSchema(db);
    equal(portfolioVisibility(db, 1), false);
    equal(portfolioVisibility(db, 1, -1), true);
    equal(portfolioVisibility(db, 1, -2), false);
  } finally {
    db.close();
    Deno.removeSync(path);
  }
});
