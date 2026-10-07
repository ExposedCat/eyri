import { equal, match, ok } from "node:assert/strict";
import { Database } from "@db/sqlite";
import { Bot } from "grammy";
import type { CustomContext } from "../bot/types.ts";
import { createReplyWithTextFunc } from "../bot/utils.ts";
import { ensureSchema } from "../database/setup.ts";
import { getUserBucket, readBucketAssignments } from "../database/bucket.ts";
import { createIntegration } from "../database/integration.ts";
import { tickersComposer } from "./composer.ts";

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
    return Promise.resolve({
      ok: true,
      result: {
        message_id: 100,
        date: 1,
        chat: { id: -1001, type: "supergroup" },
      },
    }) as never;
  });
  bot.use(async (ctx, next) => {
    db.prepare("INSERT OR IGNORE INTO users(user_id) VALUES (?)").run(
      ctx.from!.id,
    );
    ctx.db = db;
    ctx.dbEntities = { user: { userId: ctx.from!.id } };
    ctx.text = createReplyWithTextFunc(ctx);
    await next();
  });
  bot.use(tickersComposer);
  let updateId = 0;
  const from = (id: number, is_bot = false) => ({
    id,
    is_bot,
    first_name: `User ${id}`,
    language_code: "en",
  });
  return {
    calls,
    async command(
      text: string,
      userId = 123456789,
      replyUserId?: number,
      replyBot = false,
    ) {
      const chat = {
        id: -1001,
        type: "supergroup" as const,
        title: "Investing",
      };
      await bot.handleUpdate({
        update_id: ++updateId,
        message: {
          message_id: updateId,
          date: 1,
          chat,
          from: from(userId),
          text,
          entities: [{
            type: "bot_command",
            offset: 0,
            length: text.split(" ")[0].length,
          }],
          ...(replyUserId === undefined ? {} : {
              reply_to_message: {
                reply_to_message: undefined,
                message_id: 99,
              date: 1,
              chat,
              from: from(replyUserId, replyBot),
              text: "hello",
            },
          }),
        },
      });
    },
    lastText: () => String(calls.at(-1)?.payload.text),
  };
}

Deno.test("bucket transfer accepts replied-to users and explicit Telegram IDs, with read-only recipient controls", async () => {
  const db = new Database(":memory:");
  try {
    ensureSchema(db);
    const h = harness(db), owner = 123456789, recipient = 987654321;
    await h.command("/bucket new Core");
    await h.command("/bucket transfer Core", owner, recipient);
    match(h.lastText(), /access granted.*987654321/);
    equal(getUserBucket(db, recipient, "Core")?.ownerUserId, owner);
    equal(getUserBucket(db, recipient, "Core")?.included, false);
    await h.command("/bucket transfer Core 1122334455", owner, recipient);
    ok(getUserBucket(db, 1122334455, "Core"));
    await h.command("/bucket transfer Core 1122334455");
    match(h.lastText(), /already has a bucket/);
    await h.command("/bucket new Core", recipient);
    match(h.lastText(), /already exists/);
    await h.command("/bucket include Core", recipient);
    equal(getUserBucket(db, recipient, "Core")?.included, true);
    await h.command("/bucket include Core", recipient);
    await h.command("/buckets", recipient);
    match(h.lastText(), /Core \(shared by 123456789, included\)/);
    await h.command("/bucket move Core", recipient);
    match(h.lastText(), /Only the bucket owner/);
    await h.command("/move_Core_1", recipient);
    match(h.lastText(), /Only the bucket owner/);
    equal(readBucketAssignments(db, owner).size, 0);
    await h.command("/bucket transfer Core 7", recipient);
    match(h.lastText(), /Only the bucket owner/);
    await h.command("/bucket exclude Core", recipient);
    equal(getUserBucket(db, recipient, "Core")?.included, false);
    await h.command("/bucket remove Core", recipient);
    equal(getUserBucket(db, recipient, "Core"), null);
    ok(getUserBucket(db, owner, "Core"));
    await h.command("/bucket transfer Core");
    match(h.lastText(), /Reply to the recipient/);
    await h.command("/bucket transfer Core", owner, 123, true);
    equal(getUserBucket(db, 123, "Core"), null);
    for (const id of ["-1", "0", "1.5", "9007199254740992", "abc"]) {
      await h.command(`/bucket transfer Core ${id}`);
      match(h.lastText(), /Use \/bucket new/);
    }
  } finally {
    db.close();
  }
});

Deno.test("shared reporting commands work without a recipient integration and never include private holdings", async () => {
  const previousFetch = globalThis.fetch;
  const previousPath = Deno.env.get("EYRI_DATABASE_PATH");
  Deno.env.set("EYRI_DATABASE_PATH", ":memory:");
  const db = new Database(":memory:");
  const requestedKeys: string[] = [];
  globalThis.fetch = (input, init) => {
    const params = new URLSearchParams(String(init?.body));
    requestedKeys.push(params.get("apiKey") ?? "");
    const cmd = params.get("cmd");
    if (cmd === "getPositionJson") {
      return Promise.resolve(Response.json({
        result: {
          ps: {
            pos: [
              {
                i: "AAPL.US",
                q: 4,
                s: 400,
                price_a: 100,
                mkt_price: 200,
                profit_close: 300,
                curr: "USD",
              },
              {
                i: "PRIVATE.US",
                q: 1,
                s: 100,
                price_a: 100,
                mkt_price: 300,
                profit_close: 100,
                curr: "USD",
              },
            ],
          },
        },
      }));
    }
    if (cmd === "getOrdersHistory") {
      return Promise.resolve(Response.json({
        orders: {
          order: [
            {
              instr: "AAPL.US",
              date: "2025-01-02",
              oper: 1,
              stat: 21,
              q: 4,
              p: 100,
              curr: "USD",
            },
            {
              instr: "PRIVATE.US",
              date: "2025-01-02",
              oper: 1,
              stat: 21,
              q: 1,
              p: 100,
              curr: "USD",
            },
          ],
        },
      }));
    }
    return Promise.resolve(Response.json({ result: { q: [] } }));
  };
  try {
    ensureSchema(db);
    const h = harness(db), owner = 123456789, recipient = 987654321;
    await h.command("/bucket new Core");
    createIntegration({
      database: db,
      userId: owner,
      kind: "f24",
      credentials: { apiKey: "owner-key", secretKey: "secret" },
    });
    db.prepare(
      "INSERT INTO portfolio_bucket_transactions(user_id,transaction_key,bucket_name) VALUES (?,?,?)",
    )
      .run(owner, JSON.stringify(["2025-01-02", "AAPL.US", "USD"]), "Core");
    await h.command("/bucket transfer Core", owner, recipient);
    await h.command("/perf Core", recipient);
    match(h.lastText(), /AAPL/);
    equal(h.lastText().includes("PRIVATE"), false);
    await h.command("/bucket include Core", recipient);
    for (
      const command of [
        "/perf",
        "/alltime",
        "/allnumber",
        "/number",
        "/dpnl",
        "/history",
        "/stocks",
        "/when AAPL.US=250",
        "/dump_tickers",
      ]
    ) {
      await h.command(command, recipient);
      equal(h.lastText().includes("PRIVATE"), false, command);
      equal(h.lastText().includes("No integrations"), false, command);
      equal(h.lastText().includes("Failed to fetch"), false, command);
    }
    ok(requestedKeys.length > 0);
    equal(requestedKeys.every((key) => key === "owner-key"), true);
  } finally {
    db.close();
    globalThis.fetch = previousFetch;
    if (previousPath === undefined) Deno.env.delete("EYRI_DATABASE_PATH");
    else Deno.env.set("EYRI_DATABASE_PATH", previousPath);
  }
});
