import { deepStrictEqual, equal, match, ok } from "node:assert/strict";
import { Database } from "@db/sqlite";
import { Bot } from "grammy";
import type { CustomContext } from "../bot/types.ts";
import { ensureSchema } from "../database/setup.ts";
import { createChartComposer, readChartSession } from "./chart_composer.ts";
import type { AllTimeDataset } from "./alltime_chart.ts";
import { HistoricalDataError } from "../market_data/errors.ts";
import { readYahooMapping } from "../market_data/mappings.ts";
import { createBucket, transferBucketAccess } from "../database/bucket.ts";

function harness(db: Database) {
  const calls: { method: string; payload: Record<string, unknown> }[] = [];
  const fetched: number[] = [];
  const rendered: number[][] = [];
  const failures = new Set<number>();
  const invalidSymbols = new Set<string>();
  const validatedSymbols: string[] = [];
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
      result: method === "answerCallbackQuery" ? true : {
        message_id: 100,
        date: 1,
        chat: {
          id: (payload as { chat_id?: number }).chat_id ?? -1001,
          type: "supergroup",
        },
        photo: [{
          file_id: "file",
          file_unique_id: "unique",
          width: 2400,
          height: 1400,
        }],
      },
    }) as never;
  });
  bot.use(async (ctx, next) => {
    ctx.db = db;
    ctx.dbEntities = { user: { userId: ctx.from!.id } };
    await next();
  });
  const composer = createChartComposer({
    dataset: (ctx, bucketName) => {
      fetched.push(ctx.from!.id);
      if (failures.has(ctx.from!.id)) {
        return Promise.reject(
          new HistoricalDataError([
            { ticker: "VUAA", symbol: "VUAA.L" },
            { ticker: "SPYL", symbol: "SPYL.L" },
            { ticker: "VUAA", symbol: "VUAA.L" },
          ]),
        );
      }
      return Promise.resolve({
        userId: ctx.from!.id,
        label: ctx.from!.first_name,
        bucketName,
        points: [{ date: "2025-01-01", percentage: 0, gain: 0 }, {
          date: "2025-01-02",
          percentage: 10,
          gain: 100,
        }],
      });
    },
    render: (_db, datasets) => {
      rendered.push(datasets.map((d) => d.userId));
      return Promise.resolve(new Uint8Array([1, 2, 3]));
    },
    validateSymbol: (symbol) => {
      validatedSymbols.push(symbol);
      return invalidSymbols.has(symbol)
        ? Promise.reject(new Error("HTTP 404"))
        : Promise.resolve();
    },
  });
  bot.use(composer);
  let updateId = 0;
  const from = (id: number) => ({
    id,
    is_bot: false,
    first_name: `User ${id}`,
  });
  return {
    calls,
    fetched,
    rendered,
    failures,
    invalidSymbols,
    validatedSymbols,
    command: (text = "/chart", userId = 1, chatId = -1001) =>
      bot.handleUpdate({
        update_id: ++updateId,
        message: {
          message_id: updateId,
          date: 1,
          chat: { id: chatId, type: "supergroup", title: "Investing" },
          from: from(userId),
          text,
          entities: [{
            type: "bot_command",
            offset: 0,
            length: text.split(" ")[0].length,
          }],
        },
      }),
    compare: (
      data: string,
      userId = 2,
      chatId = -1001,
      messageId = 100,
    ) =>
      bot.handleUpdate({
        update_id: ++updateId,
        callback_query: {
          id: `c${updateId}`,
          from: from(userId),
          chat_instance: "one",
          data,
          message: {
            message_id: messageId,
            date: 1,
            chat: { id: chatId, type: "supergroup", title: "Investing" },
            photo: [{
              file_id: "file",
              file_unique_id: "unique",
              width: 2400,
              height: 1400,
            }],
          },
        },
      }),
  };
}
function callback(
  calls: { method: string; payload: Record<string, unknown> }[],
) {
  const send = calls.find((c) => c.method === "sendPhoto")!;
  const data = (send.payload.reply_markup as {
    inline_keyboard: { callback_data: string }[][];
  }).inline_keyboard[0][0].callback_data;
  return data;
}

Deno.test("/chart sends one photo with Compare and compares only clickers' own accounts", async () => {
  const db = new Database(":memory:");
  ensureSchema(db);
  try {
    const h = harness(db);
    await h.command();
    const data = callback(h.calls);
    equal(h.calls.filter((c) => c.method === "sendPhoto").length, 1);
    equal(h.calls.filter((c) => c.method === "sendDocument").length, 0);
    ok(new TextEncoder().encode(data).length <= 64);
    await h.compare(data);
    deepStrictEqual(h.fetched, [1, 2]);
    deepStrictEqual(h.rendered, [[1], [1, 2]]);
    const edit = h.calls.find((c) => c.method === "editMessageMedia")!;
    equal((edit.payload.media as { type: string }).type, "photo");
    const session = readChartSession(db, data.split(":")[1], -1001, 100)!;
    deepStrictEqual(
      (JSON.parse(session.datasets) as AllTimeDataset[]).map((d) => d.userId),
      [1, 2],
    );
    await h.compare(data, 2);
    equal(h.fetched.length, 2);
    match(String(h.calls.at(-1)!.payload.text), /already on this chart/);
  } finally {
    db.close();
  }
});

Deno.test("Compare survives composer restart and rejects forwarded/cross-chat or wrong-message buttons", async () => {
  const db = new Database(":memory:");
  ensureSchema(db);
  try {
    const first = harness(db);
    await first.command();
    const data = callback(first.calls);
    const resumed = harness(db);
    await resumed.compare(data, 2, -1002);
    await resumed.compare(data, 2, -1001, 101);
    equal(resumed.fetched.length, 0);
    await resumed.compare(data, 2);
    deepStrictEqual(resumed.fetched, [2]);
  } finally {
    db.close();
  }
});

Deno.test("concurrent comparisons retain both participants and remove Compare at six", async () => {
  const db = new Database(":memory:");
  ensureSchema(db);
  try {
    const h = harness(db);
    await h.command();
    const data = callback(h.calls);
    await Promise.all([h.compare(data, 2), h.compare(data, 3)]);
    await h.compare(data, 4);
    await h.compare(data, 5);
    await h.compare(data, 6);
    deepStrictEqual(h.rendered.at(-1), [1, 2, 3, 4, 5, 6]);
    const last = h.calls.filter((c) => c.method === "editMessageMedia").at(-1)!;
    deepStrictEqual(last.payload.reply_markup, { inline_keyboard: [] });
    await h.compare(data, 7);
    equal(h.fetched.length, 6);
    match(String(h.calls.at(-1)!.payload.text), /six portfolios/);
  } finally {
    db.close();
  }
});

Deno.test("invalid bucket names cannot start a chart or fetch account data", async () => {
  const db = new Database(":memory:");
  ensureSchema(db);
  try {
    const h = harness(db);
    await h.command("/chart Missing");
    await h.command("/chart invalid-name");
    equal(h.fetched.length, 0);
    equal(h.calls.filter((c) => c.method === "sendPhoto").length, 0);
  } finally {
    db.close();
  }
});

Deno.test("chart accepts a shared bucket for its recipient and rejects ungranted users", async () => {
  const db = new Database(":memory:");
  ensureSchema(db);
  try {
    db.exec("INSERT INTO users (user_id) VALUES (1), (2), (3)");
    await createBucket({ database: db, userId: 1, name: "Core" });
    ok(transferBucketAccess({ database: db, userId: 1, name: "Core", recipientId: 2 }).success);
    const h = harness(db);
    await h.command("/chart Core", 2);
    deepStrictEqual(h.fetched, [2]);
    equal(h.calls.filter((c) => c.method === "sendPhoto").length, 1);
    await h.command("/chart Core", 3);
    deepStrictEqual(h.fetched, [2]);
    match(String(h.calls.at(-1)?.payload.text), /Bucket not found/);
  } finally { db.close(); }
});

Deno.test("/chart reports historical failure without rendering or sending a partial image", async () => {
  const db = new Database(":memory:");
  ensureSchema(db);
  try {
    const h = harness(db);
    h.failures.add(1);
    await h.command();
    deepStrictEqual(h.rendered, []);
    equal(h.calls.filter((c) => c.method === "sendPhoto").length, 0);
    const reply = h.calls.find((c) => c.method === "sendMessage")!;
    equal(
      reply.payload.text,
      "Failed to fetch historical data:\n- <code>/yahoo VUAA VUAA.L</code>\n- <code>/yahoo SPYL SPYL.L</code>",
    );
    equal(reply.payload.parse_mode, "HTML");
  } finally {
    db.close();
  }
});

Deno.test("failed Compare sends an error and preserves the complete existing image and participants", async () => {
  const db = new Database(":memory:");
  ensureSchema(db);
  try {
    const h = harness(db);
    await h.command();
    const data = callback(h.calls);
    const before =
      readChartSession(db, data.split(":")[1], -1001, 100)!.datasets;
    h.failures.add(2);
    await h.compare(data, 2);
    deepStrictEqual(h.rendered, [[1]]);
    equal(h.calls.filter((c) => c.method === "editMessageMedia").length, 0);
    equal(
      readChartSession(db, data.split(":")[1], -1001, 100)!.datasets,
      before,
    );
    match(
      String(h.calls.at(-1)!.payload.text),
      /Failed to fetch historical data:/,
    );
    h.failures.delete(2);
    await h.compare(data, 2);
    equal(h.calls.filter((c) => c.method === "editMessageMedia").length, 1);
  } finally {
    db.close();
  }
});

Deno.test("/yahoo validates global mappings, shares updates and resets across users, and survives restarts", async () => {
  const db = new Database(":memory:");
  ensureSchema(db);
  try {
    const h = harness(db);
    await h.command("/yahoo vuaa vuaa.l", 1);
    equal(readYahooMapping(db, "VUAA"), "VUAA.L");
    match(String(h.calls.at(-1)!.payload.text), /Global Yahoo mapping saved/);
    deepStrictEqual(h.validatedSymbols, ["VUAA.L"]);
    const restart = harness(db);
    await restart.command("/yahoo VUAA VUAA.DE", 2);
    equal(readYahooMapping(db, "VUAA"), "VUAA.DE");
    restart.invalidSymbols.add("BROKEN");
    await restart.command("/yahoo VUAA BROKEN", 1);
    equal(readYahooMapping(db, "VUAA"), "VUAA.DE");
    equal(
      restart.calls.at(-1)!.payload.text,
      "Failed to fetch historical data:\n- <code>/yahoo VUAA BROKEN</code>",
    );
    await restart.command("/yahoo +AMD.15JAN2027.C280 AMD270115C00280000", 1);
    equal(readYahooMapping(db, "+AMD.15JAN2027.C280"), "AMD270115C00280000");
    await restart.command("/yahoo VUAA -", 1);
    equal(readYahooMapping(db, "VUAA"), undefined);
    match(String(restart.calls.at(-1)!.payload.text), /Global Yahoo mapping removed/);
    for (
      const text of [
        "/yahoo",
        "/yahoo VUAA",
        "/yahoo VUAA TOO MANY",
        "/yahoo VUAA <script>",
      ]
    ) {
      await restart.command(text);
      match(
        String(restart.calls.at(-1)!.payload.text),
        /Use <code>\/yahoo TICKER MAPPING<\/code>/,
      );
    }
    deepStrictEqual(h.rendered, []);
    deepStrictEqual(restart.rendered, []);
    equal(restart.calls.filter((c) => c.method === "sendPhoto").length, 0);
  } finally {
    db.close();
  }
});
