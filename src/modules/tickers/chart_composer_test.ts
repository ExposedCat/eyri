import { deepStrictEqual, equal, match, ok } from "node:assert/strict";
import { Database } from "@db/sqlite";
import { Bot, InlineKeyboard } from "grammy";
import type { CustomContext } from "../bot/types.ts";
import { ensureSchema } from "../database/setup.ts";
import { createChartComposer, readChartSession } from "./chart_composer.ts";
import { type AllTimeDataset, switchChartBenchmarks } from "./alltime_chart.ts";
import { dayAfter } from "../market_data/history.ts";
import { HistoricalDataError } from "../market_data/errors.ts";
import { readYahooMapping } from "../market_data/mappings.ts";
import { createBucket, transferBucketAccess } from "../database/bucket.ts";

function harness(db: Database, currencies = new Map<number, string>()) {
  const calls: { method: string; payload: Record<string, unknown> }[] = [];
  const fetched: number[] = [];
  const rendered: number[][] = [];
  const renderedDatasets: AllTimeDataset[][] = [];
  const failures = new Set<number>();
  const apiFailures = new Set<string>();
  const datasetGates = new Map<number, () => Promise<void>>();
  const pointsByUser = new Map<number, AllTimeDataset["points"]>();
  const benchmarkRequests: { symbol: string; start: string; end: string }[] = [];
  const benchmarkFailures = new Set<string>();
  const benchmarkGates = new Map<string, () => Promise<void>>();
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
    if (apiFailures.has(method)) return Promise.reject(new Error(`${method} failed`));
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
    ctx.dbEntities = { user: { userId: ctx.from!.id, currency: currencies.get(ctx.from!.id) } };
    await next();
  });
  const composer = createChartComposer({
    request: async () => Response.json({ base: "USD", quote: "EUR", rate: .8 }),
    dataset: async (ctx, bucketName) => {
      fetched.push(ctx.from!.id);
      await datasetGates.get(ctx.from!.id)?.();
      if (failures.has(ctx.from!.id)) {
        return Promise.reject(
          new HistoricalDataError([
            { ticker: "VUAA", symbol: "VUAA.L" },
            { ticker: "SPYL", symbol: "SPYL.L" },
            { ticker: "VUAA", symbol: "VUAA.L" },
          ]),
        );
      }
      const points = pointsByUser.get(ctx.from!.id) ?? [{ date: "2025-01-01", percentage: 0, gain: 0 }, {
        date: "2025-01-02", percentage: 10, gain: 100,
      }];
      return Promise.resolve({
        userId: ctx.from!.id,
        label: ctx.from!.first_name,
        bucketName,
        points,
        benchmarkPurchases: points.map((p, i) => ({ date: p.date, amountUsd: i === 0 ? 1000 : 100 })),
        benchmark: {
          label: "If S&P 500 (CSPX.L)", symbol: "CSPX.L",
          asOf: points.at(-1)!.date,
          points: points.map((p) => ({ ...p, percentage: p.percentage / 2, gain: p.gain / 2 })),
        },
      });
    },
    switchBenchmarks: (db, datasets, index) => switchChartBenchmarks(db, datasets, index, {
      get: async (symbol, start, end) => {
        benchmarkRequests.push({ symbol, start, end: end! });
        await benchmarkGates.get(symbol)?.();
        if (benchmarkFailures.has(symbol)) throw new Error("Unavailable");
        return {
          symbol, currency: "USD", instrumentType: "ETF", splits: [],
          bars: [{ date: start, close: 100 }, { date: dayAfter(end!, -1), close: 120 }],
        };
      },
    }),
    render: (_db, datasets) => {
      rendered.push(datasets.map((d) => d.userId));
      renderedDatasets.push(structuredClone(datasets));
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
    renderedDatasets,
    failures,
    apiFailures,
    datasetGates,
    pointsByUser,
    benchmarkRequests,
    benchmarkFailures,
    benchmarkGates,
    invalidSymbols,
    validatedSymbols,
    command: (text = "/chart", userId = 1, chatId = -1001) =>
      bot.handleUpdate({
        update_id: ++updateId,
        message: {
          message_id: updateId,
          date: 1,
          chat: chatId > 0
            ? { id: chatId, type: "private", first_name: `User ${chatId}` }
            : { id: chatId, type: "supergroup", title: "Investing" },
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
            chat: chatId > 0
              ? { id: chatId, type: "private", first_name: `User ${chatId}` }
              : { id: chatId, type: "supergroup", title: "Investing" },
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
function chartKeyboard(data: string, compareLabel: string | null = "Compare", index = "sp500") {
  const id = data.split(":")[1];
  const keyboard = new InlineKeyboard();
  if (compareLabel) keyboard.text(compareLabel, `chart_compare:${id}`);
  return keyboard.text(index === "sp500" ? "S&P 500" : "Momentum", `chart_index:${id}:${index}`);
}
function indexCallback(calls: { method: string; payload: Record<string, unknown> }[]) {
  const call = calls.filter(c => c.method === "sendPhoto" || c.method === "editMessageMedia").at(-1)!;
  const rows = (call.payload.reply_markup as { inline_keyboard: { callback_data: string }[][] }).inline_keyboard;
  return rows.flat().find(button => button.callback_data.startsWith("chart_index:"))!.callback_data;
}

Deno.test("/chart sends one photo with Compare and compares only clickers' own accounts", async () => {
  const db = new Database(":memory:");
  ensureSchema(db);
  try {
    const h = harness(db);
    await h.command();
    const data = callback(h.calls);
    deepStrictEqual(h.calls.find(c => c.method === "sendPhoto")!.payload.reply_markup, chartKeyboard(data));
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

Deno.test("DM charts show only the index toggle and never accept Compare clicks", async () => {
  const db = new Database(":memory:");
  ensureSchema(db);
  try {
    const h = harness(db);
    await h.command("/chart", 1, 1);
    const photo = h.calls.find((c) => c.method === "sendPhoto")!;
    const toggle = indexCallback(h.calls);
    deepStrictEqual(photo.payload.reply_markup, chartKeyboard(toggle, null));
    ok(new TextEncoder().encode(toggle).length <= 64);
    ok(readChartSession(db, toggle.split(":")[1], 1, 100));
    await h.compare(toggle, 1, 1);
    deepStrictEqual(h.calls.filter(c => c.method === "editMessageMedia").at(-1)!.payload.reply_markup,
      chartKeyboard(toggle, null, "momentum"));
    deepStrictEqual(h.fetched, [1]);
    deepStrictEqual(h.benchmarkRequests.map(r => r.symbol), ["IUMO.L"]);

    await h.command();
    const data = callback(h.calls.filter((c) => c !== photo));
    db.prepare("UPDATE alltime_chart_sessions SET chat_id = '1'").run();
    await h.compare(data, 2, 1);
    deepStrictEqual(h.fetched, [1, 1]);
    match(String(h.calls.at(-1)!.payload.text), /unavailable/);
  } finally {
    db.close();
  }
});

Deno.test("Compare keeps the original date range and point values across older/newer histories and restarts", async () => {
  const db = new Database(":memory:");
  ensureSchema(db);
  try {
    const first = harness(db);
    const original = [
      { date: "2025-05-01", percentage: 2, gain: 20 },
      { date: "2025-10-01", percentage: 10, gain: 100 },
    ];
    first.pointsByUser.set(1, original);
    await first.command();
    const data = callback(first.calls);
    const h = harness(db);
    const inRange = [
      { date: "2025-05-01", percentage: 30, gain: 300 },
      { date: "2025-07-01", percentage: 35, gain: 350 },
      { date: "2025-10-01", percentage: 40, gain: 400 },
    ];
    h.pointsByUser.set(2, [
      { date: "2020-01-01", percentage: 0, gain: 0 },
      { date: "2025-04-30", percentage: 29, gain: 290 },
      ...inRange,
      { date: "2025-10-02", percentage: 41, gain: 410 },
      { date: "2026-10-15", percentage: 60, gain: 600 },
    ]);
    await h.compare(data);
    deepStrictEqual(h.renderedDatasets[0].map((d) => d.points), [original, inRange]);
    deepStrictEqual(h.renderedDatasets[0][0].benchmark, first.renderedDatasets[0][0].benchmark);
    deepStrictEqual(h.renderedDatasets[0][1].benchmark!.points,
      inRange.map(p => ({ ...p, percentage: p.percentage / 2, gain: p.gain / 2 })));
    const resumed = harness(db);
    const laterStart = [
      { date: "2025-07-01", percentage: 0, gain: 0 },
      { date: "2025-10-01", percentage: 5, gain: 50 },
    ];
    resumed.pointsByUser.set(3, [
      ...laterStart,
      { date: "2026-10-15", percentage: 15, gain: 150 },
    ]);
    await resumed.compare(data, 3);
    deepStrictEqual(resumed.renderedDatasets[0].map((d) => d.points), [original, inRange, laterStart]);
    deepStrictEqual(resumed.renderedDatasets[0].slice(0, 2).map(d => d.benchmark),
      h.renderedDatasets[0].map(d => d.benchmark));
    deepStrictEqual(resumed.renderedDatasets[0][2].benchmark!.points,
      laterStart.map(p => ({ ...p, percentage: p.percentage / 2, gain: p.gain / 2 })));
    const stored = JSON.parse(readChartSession(db, data.split(":")[1], -1001, 100)!.datasets);
    deepStrictEqual(stored, resumed.renderedDatasets[0]);
  } finally {
    db.close();
  }
});

Deno.test("Compare rejects a portfolio outside the chart date range and releases the lock for retry", async () => {
  const db = new Database(":memory:");
  ensureSchema(db);
  try {
    const h = harness(db);
    await h.command();
    const data = callback(h.calls);
    h.pointsByUser.set(2, [{ date: "2026-01-01", percentage: 0, gain: 0 }]);
    await h.compare(data);
    match(String(h.calls.at(-1)!.payload.text), /no performance history within this chart's date range/);
    deepStrictEqual(h.rendered, [[1]]);
    h.pointsByUser.delete(2);
    await h.compare(data);
    deepStrictEqual(h.rendered, [[1], [1, 2]]);
  } finally {
    db.close();
  }
});

Deno.test("failed comparison media upload restores Compare and leaves the saved chart intact for retry", async () => {
  const db = new Database(":memory:");
  ensureSchema(db);
  try {
    const h = harness(db);
    await h.command();
    const data = callback(h.calls);
    const before = readChartSession(db, data.split(":")[1], -1001, 100)!.datasets;
    h.apiFailures.add("editMessageMedia");
    await h.compare(data);
    equal(readChartSession(db, data.split(":")[1], -1001, 100)!.datasets, before);
    const restored = h.calls.filter((c) => c.method === "editMessageReplyMarkup").at(-1)!;
    deepStrictEqual(restored.payload.reply_markup, chartKeyboard(data));
    h.apiFailures.delete("editMessageMedia");
    await h.compare(data);
    const saved = JSON.parse(readChartSession(db, data.split(":")[1], -1001, 100)!.datasets);
    deepStrictEqual(saved.map((d: AllTimeDataset) => d.userId), [1, 2]);
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

Deno.test("legacy comparison sessions require a new chart without fetching any participant's accounts", async () => {
  const db = new Database(":memory:");
  ensureSchema(db);
  try {
    const first = harness(db);
    await first.command();
    const data = callback(first.calls);
    const id = data.split(":")[1];
    const datasets = JSON.parse(readChartSession(db, id, -1001, 100)!.datasets) as AllTimeDataset[];
    delete datasets[0].benchmark;
    db.prepare("UPDATE alltime_chart_sessions SET datasets = ? WHERE id = ?")
      .run(JSON.stringify(datasets), id);
    const resumed = harness(db);
    await resumed.compare(data);
    deepStrictEqual(resumed.fetched, []);
    match(String(resumed.calls.at(-1)!.payload.text), /Create a new chart with \/chart/);
  } finally { db.close(); }
});

Deno.test("Compare shows the pending name, rejects concurrent clicks without queuing, and removes Compare at six", async () => {
  const db = new Database(":memory:");
  ensureSchema(db);
  try {
    const h = harness(db);
    await h.command();
    const data = callback(h.calls);
    const started = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    h.datasetGates.set(2, () => {
      started.resolve();
      return finish.promise;
    });
    const adding = h.compare(data, 2);
    await started.promise;
    const busy = h.calls.find((c) => c.method === "editMessageReplyMarkup")!;
    deepStrictEqual(busy.payload.reply_markup, chartKeyboard(data, "Adding User 2..."));
    await Promise.all([h.compare(data, 2), h.compare(data, 3)]);
    await h.compare(indexCallback(h.calls), 1);
    equal(h.benchmarkRequests.length, 0);
    deepStrictEqual(h.fetched, [1, 2]);
    match(String(h.calls.at(-1)!.payload.text), /updating/);
    finish.resolve();
    await adding;
    deepStrictEqual(h.rendered.at(-1), [1, 2]);
    const restored = h.calls.find((c) => c.method === "editMessageMedia")!;
    deepStrictEqual(restored.payload.reply_markup, chartKeyboard(data));
    await h.compare(data, 3);
    await h.compare(data, 4);
    await h.compare(data, 5);
    await h.compare(data, 6);
    deepStrictEqual(h.rendered.at(-1), [1, 2, 3, 4, 5, 6]);
    const last = h.calls.filter((c) => c.method === "editMessageMedia").at(-1)!;
    deepStrictEqual(last.payload.reply_markup, chartKeyboard(data, null));
    await h.compare(indexCallback(h.calls), 1);
    deepStrictEqual(h.renderedDatasets.at(-1)!.map(d => d.benchmark!.symbol), Array(6).fill("IUMO.L"));
    deepStrictEqual(h.calls.filter(c => c.method === "editMessageMedia").at(-1)!.payload.reply_markup,
      chartKeyboard(data, null, "momentum"));
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
    const restored = h.calls.filter((c) => c.method === "editMessageReplyMarkup").at(-1)!;
    deepStrictEqual(restored.payload.reply_markup, chartKeyboard(data));
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

Deno.test("Compare changes a preferred-currency chart to USD while preserving original snapshots, including after restart", async () => {
  const db = new Database(":memory:");
  ensureSchema(db);
  try {
    const currencies = new Map([[1, "EUR"], [2, "GBP"]]);
    const first = harness(db, currencies);
    await first.command();
    const data = callback(first.calls);
    const initial = first.renderedDatasets[0][0];
    equal(initial.displayCurrency, "EUR");
    equal(initial.displayRate, .8);
    equal(initial.points.at(-1)!.gain, 100);
    const resumed = harness(db, currencies);
    resumed.failures.add(2);
    await resumed.compare(data);
    let session = readChartSession(db, data.split(":")[1], -1001, 100)!;
    deepStrictEqual(JSON.parse(session.datasets), [initial]);
    resumed.failures.delete(2);
    await resumed.compare(data);
    deepStrictEqual(resumed.fetched, [2, 2]);
    const compared = resumed.renderedDatasets[0];
    deepStrictEqual(compared.map((d) => d.displayCurrency ?? "USD"), ["USD", "USD"]);
    deepStrictEqual(compared[0].points, initial.points);
    equal(compared[1].points.at(-1)!.gain, 100);
    session = readChartSession(db, data.split(":")[1], -1001, 100)!;
    deepStrictEqual(JSON.parse(session.datasets), compared);
  } finally {
    db.close();
  }
});

Deno.test("index toggle switches every participant, survives restart, and restores frozen S&P curves", async () => {
  const db = new Database(":memory:");
  ensureSchema(db);
  try {
    const h = harness(db);
    await h.command();
    const compare = callback(h.calls);
    await h.compare(compare);
    const before = JSON.parse(readChartSession(db, compare.split(":")[1], -1001, 100)!.datasets) as AllTimeDataset[];
    const toggle = indexCallback(h.calls);
    const resumed = harness(db);
    await resumed.compare(toggle, 3, -1002);
    await resumed.compare(toggle, 3, -1001, 101);
    equal(resumed.benchmarkRequests.length, 0);
    await resumed.compare(toggle, 3);
    deepStrictEqual(resumed.fetched, []);
    const changed = resumed.renderedDatasets[0];
    deepStrictEqual(changed.map(d => d.benchmark!.symbol), ["IUMO.L", "IUMO.L"]);
    deepStrictEqual(changed.map(d => d.points), before.map(d => d.points));
    deepStrictEqual(changed.map(d => d.benchmarkPurchases), before.map(d => d.benchmarkPurchases));
    deepStrictEqual(resumed.benchmarkRequests.map(r => r.symbol), ["IUMO.L", "IUMO.L"]);
    const media = resumed.calls.find(c => c.method === "editMessageMedia")!;
    deepStrictEqual(media.payload.reply_markup, chartKeyboard(compare, "Compare", "momentum"));
    const edits = resumed.calls.filter(c => c.method === "editMessageMedia").length;
    await resumed.compare(toggle, 3);
    equal(resumed.calls.filter(c => c.method === "editMessageMedia").length, edits);
    match(String(resumed.calls.at(-1)!.payload.text), /already changed/);
    const restart = harness(db);
    await restart.compare(indexCallback(resumed.calls), 3);
    deepStrictEqual(restart.fetched, []);
    deepStrictEqual(restart.benchmarkRequests, []);
    deepStrictEqual(restart.renderedDatasets[0].map(d => d.benchmark), before.map(d => d.benchmark));
    deepStrictEqual(restart.calls.find(c => c.method === "editMessageMedia")!.payload.reply_markup, chartKeyboard(compare));
  } finally { db.close(); }
});

Deno.test("index changes preserve single-chart preferred currency and DM keyboard after restart", async () => {
  const db = new Database(":memory:");
  ensureSchema(db);
  try {
    const first = harness(db, new Map([[1, "EUR"]]));
    await first.command("/chart", 1, 1);
    const before = first.renderedDatasets[0][0];
    const resumed = harness(db);
    await resumed.compare(indexCallback(first.calls), 1, 1);
    const changed = resumed.renderedDatasets[0][0];
    equal(changed.displayCurrency, "EUR");
    equal(changed.displayRate, .8);
    deepStrictEqual(changed.points, before.points);
    equal(changed.benchmark!.symbol, "IUMO.L");
    deepStrictEqual(resumed.fetched, []);
    deepStrictEqual(resumed.calls.find(c => c.method === "editMessageMedia")!.payload.reply_markup,
      chartKeyboard(indexCallback(first.calls), null, "momentum"));
  } finally { db.close(); }
});

Deno.test("a participant joining a Momentum chart uses Momentum and keeps the original window", async () => {
  const db = new Database(":memory:");
  ensureSchema(db);
  try {
    const h = harness(db);
    await h.command();
    const compare = callback(h.calls);
    await h.compare(indexCallback(h.calls), 1);
    const original = structuredClone(h.renderedDatasets.at(-1)![0]);
    const resumed = harness(db);
    resumed.pointsByUser.set(2, [
      { date: "2020-01-01", percentage: 0, gain: 0 },
      { date: "2025-01-01", percentage: 10, gain: 100 },
      { date: "2025-01-02", percentage: 12, gain: 120 },
      { date: "2026-10-15", percentage: 15, gain: 150 },
    ]);
    await resumed.compare(compare);
    deepStrictEqual(resumed.fetched, [2]);
    const datasets = resumed.renderedDatasets[0];
    deepStrictEqual(datasets[0], original);
    deepStrictEqual(datasets.map(d => d.benchmark!.symbol), ["IUMO.L", "IUMO.L"]);
    deepStrictEqual(datasets[1].points.map(p => p.date), ["2025-01-01", "2025-01-02"]);
    deepStrictEqual(datasets[1].benchmark!.points.map(p => p.date), ["2025-01-01", "2025-01-02"]);
    equal(datasets[1].benchmarkSnapshots!.sp500!.points[0].date, "2025-01-01");
    equal(datasets[1].benchmarkPurchases![0].date, "2020-01-01");
    equal(resumed.benchmarkRequests[0].symbol, "IUMO.L");
    equal(resumed.benchmarkRequests[0].start, "2019-12-25");
    equal(resumed.benchmarkRequests[0].end, "2025-01-03");
  } finally { db.close(); }
});

Deno.test("index switching locks both buttons and failures restore the original chart and keyboard", async () => {
  const db = new Database(":memory:");
  ensureSchema(db);
  try {
    const h = harness(db);
    await h.command();
    const compare = callback(h.calls);
    const toggle = indexCallback(h.calls);
    const before = readChartSession(db, compare.split(":")[1], -1001, 100)!.datasets;
    const started = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    h.benchmarkGates.set("IUMO.L", () => { started.resolve(); return finish.promise; });
    h.benchmarkFailures.add("IUMO.L");
    const updating = h.compare(toggle, 1);
    await started.promise;
    const busy = h.calls.find(c => c.method === "editMessageReplyMarkup")!;
    deepStrictEqual(busy.payload.reply_markup, new InlineKeyboard().text("Compare", compare).text("Switching...", toggle));
    await Promise.all([h.compare(compare), h.compare(toggle)]);
    deepStrictEqual(h.fetched, [1]);
    equal(h.benchmarkRequests.length, 1);
    match(String(h.calls.at(-1)!.payload.text), /updating/);
    finish.resolve();
    await updating;
    equal(readChartSession(db, compare.split(":")[1], -1001, 100)!.datasets, before);
    equal(h.calls.filter(c => c.method === "editMessageMedia").length, 0);
    deepStrictEqual(h.calls.filter(c => c.method === "editMessageReplyMarkup").at(-1)!.payload.reply_markup, chartKeyboard(compare));
    match(String(h.calls.at(-1)!.payload.text), /Momentum.*unavailable/);
    h.benchmarkFailures.clear();
    await h.compare(toggle, 1);
    equal(h.renderedDatasets.at(-1)![0].benchmark!.symbol, "IUMO.L");
  } finally { db.close(); }
});

Deno.test("failed toggle media upload preserves the session and can be retried", async () => {
  const db = new Database(":memory:");
  ensureSchema(db);
  try {
    const h = harness(db);
    await h.command();
    const compare = callback(h.calls);
    const toggle = indexCallback(h.calls);
    const before = readChartSession(db, compare.split(":")[1], -1001, 100)!.datasets;
    h.apiFailures.add("editMessageMedia");
    await h.compare(toggle, 1);
    equal(readChartSession(db, compare.split(":")[1], -1001, 100)!.datasets, before);
    deepStrictEqual(h.calls.filter(c => c.method === "editMessageReplyMarkup").at(-1)!.payload.reply_markup, chartKeyboard(compare));
    h.apiFailures.clear();
    await h.compare(toggle, 1);
    const saved = JSON.parse(readChartSession(db, compare.split(":")[1], -1001, 100)!.datasets) as AllTimeDataset[];
    equal(saved[0].benchmark!.symbol, "IUMO.L");
  } finally { db.close(); }
});

Deno.test("index switching asks to recreate older charts lacking saved purchase amounts", async () => {
  const db = new Database(":memory:");
  ensureSchema(db);
  try {
    const h = harness(db);
    await h.command();
    const compare = callback(h.calls);
    const id = compare.split(":")[1];
    const saved = JSON.parse(readChartSession(db, id, -1001, 100)!.datasets) as AllTimeDataset[];
    delete saved[0].benchmarkPurchases;
    db.prepare("UPDATE alltime_chart_sessions SET datasets = ? WHERE id = ?").run(JSON.stringify(saved), id);
    await h.compare(indexCallback(h.calls));
    match(String(h.calls.at(-1)!.payload.text), /Create a new chart/);
    equal(h.benchmarkRequests.length, 0);
    deepStrictEqual(h.fetched, [1]);
  } finally { db.close(); }
});
