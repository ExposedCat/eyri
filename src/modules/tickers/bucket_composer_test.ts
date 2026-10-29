import { equal, match, ok } from "node:assert/strict";
import { Database } from "@db/sqlite";
import { Bot } from "grammy";
import type { CustomContext } from "../bot/types.ts";
import { createReplyWithTextFunc } from "../bot/utils.ts";
import { ensureSchema } from "../database/setup.ts";
import { findOrCreateUser, setUserCurrency } from "../database/user.ts";
import { getUserBucket, readBucketAssignments } from "../database/bucket.ts";
import { createIntegration } from "../database/integration.ts";
import { ibkrAdapter } from "../integrations/ibkr/adapter.ts";
import type { IntegrationOrder, IntegrationPortfolioPosition } from "../integrations/types.ts";
import { getOrderTransactionKey } from "./portfolio.ts";
import { tickersComposer } from "./composer.ts";

function fundedReport(holdings: { i: string; q: number; value: number }[], deposits: number, cash = 0) {
  const flow = { id: 1, type: "bank", amount: deposits, value_usd: deposits, pay_d: "2025-01-01", currency: "USD", approved: 1, reverted: 0, phantom: 0, offbalance: null };
  return { report: { date_start: "1970-01-01", date_end: new Date().toISOString().slice(0, 10),
    plainAccountInfoData: { client_date_open: "2025-01-01", base_currency: "USD" },
    account_at_start: { account: { net_assets: 0, positions_from_ts: { ps: { acc: [{ curr: "USD", s: 0 }], pos: [] } } } },
    account_at_end: { account: { net_assets: cash + holdings.reduce((sum, holding) => sum + holding.value, 0),
      positions_from_ts: { ps: { acc: [{ curr: "USD", s: cash, net_assets: cash }], pos: holdings.map(holding => ({ i: holding.i, q: holding.q, net_assets: holding.value })) } } } },
    cash_in_outs: [flow], cash_flows: { detailed: [{ type_id: "bank", amount: deposits }], total: { USD: deposits } }, securities_in_outs: [] } };
}

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
    ctx.dbEntities = { user: await findOrCreateUser(db, ctx.from!.id) };
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
    async click(data: string, userId = 123456789) {
      await bot.handleUpdate({
        update_id: ++updateId,
        callback_query: {
          id: String(updateId),
          from: from(userId),
          chat_instance: "chat",
          data,
          message: {
            message_id: 42,
            date: 1,
            chat: { id: -1001, type: "supergroup", title: "Investing" },
            text: "bucket",
          },
        },
      });
    },
    lastText: () => String(calls.at(-1)?.payload.text),
  };
}

Deno.test("stock reports, dumps and allocation charts ignore unavailable warrant feeds, including shared buckets", async () => {
  const db = new Database(":memory:");
  const previousPath = Deno.env.get("EYRI_DATABASE_PATH");
  const previousFetch = globalThis.fetch;
  const previousPortfolio = ibkrAdapter.fetchPortfolio;
  const previousOrders = ibkrAdapter.fetchOrderHistory;
  Deno.env.set("EYRI_DATABASE_PATH", ":memory:");
  let issuerRequests = 0;
  try {
    ensureSchema(db);
    const owner = 123456789, recipient = 987654321;
    const h = harness(db);
    await h.command("/bucket new Core");
    const saved = createIntegration({ database: db, userId: owner, kind: "ibkr", credentials: {} });
    ok(saved.data);
    const stock: IntegrationPortfolioPosition = {
      integrationId: saved.data.id, integrationKind: "ibkr", account: "test",
      ticker: "AAPL", assetCategory: "STK", currency: "USD", amount: 10,
      averageUnitPrice: 100, currentPrice: 120, totalInput: 1000, totalNow: 1200,
      unrealizedPnl: 200, realizedPnl: 0, dailyPnl: 10,
      dailyPnlPercentage: 1, dailyPnlBaseline: 1000, openedAt: new Date("2025-01-01"),
    };
    const warrant = { ...stock, ticker: "BD3G1A", assetCategory: "WAR", currency: "EUR" };
    const orders: IntegrationOrder[] = [stock, warrant].map((p) => ({
      integrationId: p.integrationId, integrationKind: p.integrationKind, account: p.account,
      ticker: p.ticker, assetCategory: p.assetCategory!, currency: p.currency,
      date: p.openedAt!, quantity: p.amount, price: p.averageUnitPrice,
    }));
    ibkrAdapter.fetchPortfolio = async () => [stock, warrant];
    ibkrAdapter.fetchOrderHistory = async () => orders;
    globalThis.fetch = async (input) => {
      if (String(input).includes("markets.vontobel.com")) {
        issuerRequests++;
        return new Response(null, { status: 503 });
      }
      throw new Error(`Unexpected request: ${input}`);
    };
    const checkReports = async (bucket = "", userId = owner) => {
      for (const command of ["/perf s", "/worth stocks", "/dpnl s", "/alltime stocks",
        "/number perf s", "/number alltime stocks", "/worthnumber s", "/allnumber stocks",
        "/dump_tickers"]) {
        await h.command(`${command}${bucket ? ` ${bucket}` : ""}`, userId);
        const text = h.lastText();
        ok(!text.includes("Failed to fetch"), text);
        if (!command.includes("number")) match(text, /AAPL/, text);
        ok(!text.includes("BD3G1A"), text);
      }
      await h.command(`/portfolio${bucket ? ` ${bucket}` : ""}`, userId);
      equal(h.calls.at(-1)?.method, "sendDocument");
      equal(issuerRequests, 0);
    };
    await checkReports();
    // Both assets are in the shared bucket; stock requests still skip the warrant.
    for (const order of orders) {
      db.prepare("INSERT INTO portfolio_bucket_transactions(user_id,transaction_key,bucket_name) VALUES (?,?,?)")
        .run(owner, getOrderTransactionKey(order), "Core");
    }
    await h.command("/bucket transfer Core", owner, recipient);
    await checkReports("Core", recipient);
    await h.command("/perf options Core", recipient);
    match(h.lastText(), /Vontobel bid quote unavailable/);
    equal(h.lastText().match(/Failed to fetch integration data:/g)?.length, 1);
    equal(issuerRequests, 1);
  } finally {
    ibkrAdapter.fetchPortfolio = previousPortfolio;
    ibkrAdapter.fetchOrderHistory = previousOrders;
    globalThis.fetch = previousFetch;
    if (previousPath === undefined) Deno.env.delete("EYRI_DATABASE_PATH");
    else Deno.env.set("EYRI_DATABASE_PATH", previousPath);
    db.close();
  }
});

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
    match(h.lastText(), /Only 0% of Core is left to transfer/);
    equal(getUserBucket(db, 1122334455, "Core"), null);
    await h.command("/bucket transfer Core", owner, recipient);
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
    await h.click(`bucket:${recipient}:move:Core:1`, recipient);
    match(h.lastText(), /Only the bucket owner/);
    await h.click(`bucket:${owner}:move:Core:1`, recipient);
    match(h.lastText(), /belongs to another user/);
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
    if (String(input).startsWith("https://api.frankfurter.dev/")) {
      return Promise.resolve(Response.json({ base: "USD", quote: "EUR", rate: .8 }));
    }
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
    await h.command("/worth Core", recipient);
    match(h.lastText(), /Total: \+100\.00% \$800\.00/);
    equal(h.lastText().includes("PRIVATE"), false);
    await h.command("/worthnumber Core", recipient);
    match(h.lastText(), /\n\$800\.00$/);
    await h.command("/bucket include Core", recipient);
    for (
      const command of [
        "/perf",
        "/alltime",
        "/allnumber",
        "/number",
        "/worth",
        "/worthnumber",
        "/dpnl",
        "/history",
        "/perf stocks",
        "/when AAPL.US=250",
        "/dump_tickers",
      ]
    ) {
      await h.command(command, recipient);
      equal(h.lastText().includes("PRIVATE"), false, command);
      equal(h.lastText().includes("No integrations"), false, command);
      if (command === "/alltime") match(h.lastText(), /Total: \+100\.00% \+\$400\.00/);
      else equal(h.lastText().includes("Failed to fetch"), false, command);
      equal(h.lastText().includes("?"), false, command);
      if (command === "/worth") match(h.lastText(), /Total: \+100\.00% \$800\.00/);
      if (command === "/worthnumber") match(h.lastText(), /\n\$800\.00$/);
    }
    setUserCurrency(db, recipient, "EUR");
    await h.command("/worth Core", recipient);
    match(h.lastText(), /Total: \+100\.00% 640\.00 EUR/);
    for (const command of ["/perf", "/alltime", "/allnumber", "/number", "/worth", "/worthnumber", "/history", "/perf stocks", "/when AAPL.US=200"]) {
      await h.command(command, recipient);
      if (command === "/alltime") match(h.lastText(), /Total: \+100\.00% \+320\.00 EUR/);
      else match(h.lastText(), / EUR/, command);
      equal(h.lastText().includes("$"), false, command);
      equal(h.lastText().includes("PRIVATE"), false, command);
    }
    match(h.lastText(), /\+480\.00 EUR \+150\.00%/);
    await h.command("/dump_tickers", recipient);
    match(h.lastText(), /"currency": "EUR"/);
    await h.command("/worth Core", owner);
    match(h.lastText(), /Total: \+100\.00% \$800\.00/);
    ok(requestedKeys.length > 0);
    equal(requestedKeys.every((key) => key === "owner-key"), true);
  } finally {
    db.close();
    globalThis.fetch = previousFetch;
    if (previousPath === undefined) Deno.env.delete("EYRI_DATABASE_PATH");
    else Deno.env.set("EYRI_DATABASE_PATH", previousPath);
  }
});

Deno.test("bucket move renders rich Move/Remove buttons and edits the clicked message", async () => {
  const previousFetch = globalThis.fetch;
  const previousPath = Deno.env.get("EYRI_DATABASE_PATH");
  Deno.env.set("EYRI_DATABASE_PATH", ":memory:");
  const db = new Database(":memory:");
  globalThis.fetch = (_input, init) => {
    const cmd = new URLSearchParams(String(init?.body)).get("cmd");
    if (cmd === "getOrdersHistory") {
      return Promise.resolve(Response.json({
        orders: {
          order: ["AAPL.US", "MSFT.US"].map((instr) => ({
            instr,
            date: "2025-01-02",
            oper: 1,
            stat: 21,
            q: 1,
            p: 100,
            curr: "USD",
          })),
        },
      }));
    }
    return Promise.resolve(Response.json({ result: { q: [] } }));
  };
  try {
    ensureSchema(db);
    const h = harness(db), owner = 123456789;
    await h.command("/bucket new Core");
    createIntegration({
      database: db,
      userId: owner,
      kind: "f24",
      credentials: { apiKey: "owner-key", secretKey: "secret" },
    });
    const richHtml = (method: string) => {
      const call = h.calls.findLast((item) => item.method === method);
      return String((call?.payload.rich_message as { html?: string })?.html);
    };
    const moveButton = (index: number) =>
      `<tg-button type="callback_data" style="danger" data="bucket:${owner}:move:Core:${index}">Move</tg-button>`;
    const removeButton = (index: number) =>
      `<tg-button type="callback_data" style="success" data="bucket:${owner}:remove:Core:${index}">Remove</tg-button>`;

    await h.command("/bucket move Core");
    const sent = richHtml("sendRichMessage");
    match(sent, /^<h2>Bucket Core<\/h2>\n<h3>2025 - /);
    ok(sent.includes(moveButton(1)) && sent.includes(moveButton(2)));
    match(sent, /<p><b>Total \$200<\/b><\/p>$/);

    await h.click(`bucket:${owner}:move:Core:1`);
    equal(readBucketAssignments(db, owner).get(JSON.stringify(["2025-01-02", "AAPL.US", "USD"])), "Core");
    const answer = h.calls.findLast((item) => item.method === "answerCallbackQuery");
    equal(answer?.payload.text, "Moved to Core");
    const edit = h.calls.at(-1);
    equal(edit?.method, "editMessageText");
    equal(edit?.payload.message_id, 42);
    const edited = richHtml("editMessageText");
    ok(edited.includes(removeButton(1)) && edited.includes(moveButton(2)));
    equal(h.calls.filter((item) => item.method === "sendRichMessage").length, 1);

    await h.click(`bucket:${owner}:remove:Core:1`);
    equal(readBucketAssignments(db, owner).size, 0);
    ok(richHtml("editMessageText").includes(moveButton(1)));

    await h.click(`bucket:${owner}:move:Core:9`);
    match(h.lastText(), /Transaction not found: 9/);
  } finally {
    db.close();
    globalThis.fetch = previousFetch;
    if (previousPath === undefined) Deno.env.delete("EYRI_DATABASE_PATH");
    else Deno.env.set("EYRI_DATABASE_PATH", previousPath);
  }
});

Deno.test("partial bucket transfers scale the recipient's view and follow owner changes", async () => {
  const previousFetch = globalThis.fetch;
  const previousPath = Deno.env.get("EYRI_DATABASE_PATH");
  Deno.env.set("EYRI_DATABASE_PATH", ":memory:");
  const db = new Database(":memory:");
  globalThis.fetch = (input, init) => {
    if (String(input).startsWith("https://api.frankfurter.dev/")) {
      return Promise.resolve(Response.json({ base: "USD", quote: "EUR", rate: .8 }));
    }
    const cmd = new URLSearchParams(String(init?.body)).get("cmd");
    if (cmd === "getPositionJson") {
      return Promise.resolve(Response.json({
        result: {
          ps: {
            pos: [
              { i: "AAPL.US", q: 4, s: 400, price_a: 100, mkt_price: 200, profit_close: 300, curr: "USD" },
              { i: "MSFT.US", q: 2, s: 200, price_a: 100, mkt_price: 150, profit_close: 100, curr: "USD" },
            ],
          },
        },
      }));
    }
    if (cmd === "getOrdersHistory") {
      return Promise.resolve(Response.json({
        orders: {
          order: [
            { instr: "AAPL.US", date: "2025-01-02", oper: 1, stat: 21, q: 4, p: 100, curr: "USD" },
            { instr: "MSFT.US", date: "2025-01-03", oper: 1, stat: 21, q: 2, p: 100, curr: "USD" },
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
    await h.command("/bucket new Growth");
    createIntegration({
      database: db,
      userId: owner,
      kind: "f24",
      credentials: { apiKey: "owner-key", secretKey: "secret" },
    });
    const assign = (ticker: string, date: string, bucket: string) =>
      db.prepare(
        "INSERT OR REPLACE INTO portfolio_bucket_transactions(user_id,transaction_key,bucket_name) VALUES (?,?,?)",
      ).run(owner, JSON.stringify([date, ticker, "USD"]), bucket);
    assign("AAPL.US", "2025-01-02", "Core");

    for (const bad of ["0 1", "101 1", "abc 1", "50 abc", "50% 1 2"]) {
      await h.command(`/bucket transfer Core ${bad}`);
      match(h.lastText(), /Use \/bucket new/, bad);
    }
    await h.command(`/bucket transfer Core 50 ${recipient}`);
    match(h.lastText(), /access granted: Core \(50%\) to 987654321/);
    equal(getUserBucket(db, recipient, "Core")?.share, 0.5);
    await h.command(`/bucket transfer Core 50 ${recipient}`);
    match(h.lastText(), /already has a bucket/);
    await h.command("/buckets", recipient);
    match(h.lastText(), /Core \(shared by 123456789, 50%\)/);

    // Half of 4 AAPL bought at $100, now $200.
    await h.command("/worth Core", recipient);
    match(h.lastText(), /Total: \+100\.00% \$400\.00/);
    await h.command("/worth Core", owner);
    match(h.lastText(), /Total: \+100\.00% \$800\.00/);

    // Owner changes flow through at the granted share.
    assign("MSFT.US", "2025-01-03", "Core");
    await h.command("/worth Core", recipient);
    match(h.lastText(), /Total: \+83\.33% \$550\.00/);

    // Included, a partial bucket behaves like any other bucket.
    await h.command("/bucket include Core", recipient);
    await h.command("/worth", recipient);
    match(h.lastText(), /Total: \+83\.33% \$550\.00/);

    // Re-granting with another share updates it.
    await h.command(`/bucket transfer Core 25 ${recipient}`);
    match(h.lastText(), /Core \(25%\)/);
    await h.command("/worth", recipient);
    match(h.lastText(), /\$275\.00/);

    // Buckets of one owner at different shares can be included together:
    // Core keeps AAPL at 25% (1 share, $100 -> $200), Growth gets MSFT at 100%
    // (2 shares, $100 -> $150).
    assign("MSFT.US", "2025-01-03", "Growth");
    await h.command(`/bucket transfer Growth ${recipient}`);
    await h.command("/bucket include Growth", recipient);
    match(h.lastText(), /included in your portfolio: Growth/);
    equal(getUserBucket(db, recipient, "Growth")?.included, true);
    await h.command("/worth", recipient);
    match(h.lastText(), /Total: \+66\.67% \$500\.00/);
    await h.command("/worth Core", recipient);
    match(h.lastText(), /Total: \+100\.00% \$200\.00/);
    await h.command("/worth Growth", recipient);
    match(h.lastText(), /Total: \+50\.00% \$300\.00/);
    // Changing one share leaves the other bucket untouched.
    await h.command(`/bucket transfer Core 10 ${recipient}`);
    match(h.lastText(), /Core \(10%\)/);
    await h.command("/worth", recipient);
    match(h.lastText(), /Total: \+58\.33% \$380\.00/);

    // Reply form takes a percentage with the % sign.
    await h.command("/bucket transfer Core 50%", owner, 1122334455);
    equal(getUserBucket(db, 1122334455, "Core")?.share, 0.5);
  } finally {
    db.close();
    globalThis.fetch = previousFetch;
    if (previousPath === undefined) Deno.env.delete("EYRI_DATABASE_PATH");
    else Deno.env.set("EYRI_DATABASE_PATH", previousPath);
  }
});

Deno.test("partial bucket moves take open portfolio shares FIFO and return them", async () => {
  const previousFetch = globalThis.fetch;
  const previousPath = Deno.env.get("EYRI_DATABASE_PATH");
  Deno.env.set("EYRI_DATABASE_PATH", ":memory:");
  const db = new Database(":memory:");
  globalThis.fetch = (input, init) => {
    if (String(input).startsWith("https://api.frankfurter.dev/")) {
      return Promise.resolve(Response.json({ base: "USD", quote: "EUR", rate: .8 }));
    }
    const cmd = new URLSearchParams(String(init?.body)).get("cmd");
    if (cmd === "getBrokerReport") return Promise.resolve(Response.json(fundedReport([{ i: "AAPL.US", q: 8, value: 1600 }], 840)));
    if (cmd === "getPositionJson") {
      return Promise.resolve(Response.json({
        result: {
          ps: {
            pos: [{ i: "AAPL.US", q: 8, s: 1000, price_a: 125, mkt_price: 200, profit_close: 600, curr: "USD" }],
          },
        },
      }));
    }
    if (cmd === "getOrdersHistory") {
      return Promise.resolve(Response.json({
        orders: {
          order: [
            { instr: "AAPL.US", date: "2025-01-02", oper: 1, stat: 21, q: 6, p: 100, curr: "USD" },
            { instr: "AAPL.US", date: "2025-02-03", oper: 1, stat: 21, q: 4, p: 150, curr: "USD" },
            { instr: "AAPL.US", date: "2025-03-01", oper: 3, stat: 21, q: 2, p: 180, curr: "USD" },
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

    for (const bad of ["AAPL", "AAPL 0", "AAPL -1", "AAPL abc", "AAPL 1 2"]) {
      await h.command(`/bucket move Core ${bad}`);
      match(h.lastText(), /Use \/bucket new/, bad);
    }
    await h.command("/bucket move Core TSLA 1");
    match(h.lastText(), /No purchases found for TSLA/);

    // 2 of the January 6 were sold, so 4 come from January and 1 from February.
    await h.command("/bucket move Core AAPL 5");
    match(h.lastText(), /Moved 5 AAPL\.US to Core/);
    await h.command("/worth Core");
    match(h.lastText(), /Total: \+81\.82% \$1,000\.00/);
    await h.command("/worth");
    match(h.lastText(), /Total: \+33\.33% \$600\.00/);
    await h.command("/bucket move Core AAPL 4");
    match(h.lastText(), /Only 3 AAPL\.US can be moved/);

    // Recipients see partial parts like any bucket content.
    await h.command(`/bucket transfer Core ${recipient}`);
    await h.command("/worth Core", recipient);
    match(h.lastText(), /\$1,000\.00/);

    // The move page lists each partial part with its own Remove button.
    await h.command("/bucket move Core");
    const page = String(
      (h.calls.findLast((call) => call.method === "sendRichMessage")?.payload
        .rich_message as { html: string }).html,
    );
    const lines = page.split("\n").filter((line) => line.includes("tg-button"));
    equal(lines.length, 4);
    match(lines[0], /2\.0000 x \$100\.00.*style="danger".*move:Core:1/);
    match(lines[1], /4\.0000 x \$100\.00.*style="success".*remove:Core:2/);
    match(lines[2], /3\.0000 x \$150\.00.*style="danger".*move:Core:3/);
    match(lines[3], /1\.0000 x \$150\.00.*style="success".*remove:Core:4/);

    // Returning the January part goes back to the portfolio for everyone.
    await h.click(`bucket:${owner}:remove:Core:2`);
    match(
      String((h.calls.at(-1)?.payload.rich_message as { html: string }).html),
      /6\.0000 x \$100\.00.*style="danger".*move:Core:1/,
    );
    await h.command("/worth Core", recipient);
    match(h.lastText(), /Total: \+33\.33% \$200\.00/);
    await h.command("/worth");
    match(h.lastText(), /\$1,400\.00/);

    // Removing the bucket returns the rest.
    await h.command("/bucket remove Core");
    await h.command("/worth");
    match(h.lastText(), /Total: \+60\.00% \$1,600\.00/);
  } finally {
    db.close();
    globalThis.fetch = previousFetch;
    if (previousPath === undefined) Deno.env.delete("EYRI_DATABASE_PATH");
    else Deno.env.set("EYRI_DATABASE_PATH", previousPath);
  }
});

Deno.test("bucket transfers share at most 100% of a bucket across recipients", async () => {
  const db = new Database(":memory:");
  try {
    ensureSchema(db);
    const h = harness(db), first = 987654321, second = 1122334455, third = 5566778899;
    await h.command("/bucket new Core");
    await h.command(`/bucket transfer Core 50 ${first}`);
    await h.command(`/bucket transfer Core 60 ${second}`);
    match(h.lastText(), /Only 50% of Core is left to transfer/);
    equal(getUserBucket(db, second, "Core"), null);
    await h.command(`/bucket transfer Core 50 ${second}`);
    match(h.lastText(), /access granted: Core \(50%\)/);
    await h.command(`/bucket transfer Core 1 ${third}`);
    match(h.lastText(), /Only 0% of Core is left/);
    await h.command(`/bucket transfer Core ${third}`);
    match(h.lastText(), /Only 0% of Core is left/);
    await h.command("/buckets");
    match(h.lastText(), /Core \(transferred 100%\)/);

    // A re-grant replaces that recipient's share instead of adding to it.
    await h.command(`/bucket transfer Core 60 ${first}`);
    match(h.lastText(), /Only 50% of Core is left/);
    await h.command(`/bucket transfer Core 30 ${first}`);
    match(h.lastText(), /Core \(30%\)/);
    await h.command(`/bucket transfer Core 20 ${third}`);
    match(h.lastText(), /Core \(20%\)/);

    // A recipient giving access up frees their share.
    await h.command("/bucket remove Core", second);
    await h.command("/buckets");
    match(h.lastText(), /Core \(transferred 50%\)/);
    await h.command(`/bucket transfer Core 50 ${second}`);
    equal(getUserBucket(db, second, "Core")?.share, 0.5);
  } finally {
    db.close();
  }
});

Deno.test("performance commands filter current and sold assets, with bot mentions and shared buckets", async () => {
  const previousFetch = globalThis.fetch;
  const previousPath = Deno.env.get("EYRI_DATABASE_PATH");
  Deno.env.set("EYRI_DATABASE_PATH", ":memory:");
  const db = new Database(":memory:");
  const optionTicker = "+MSFT.19DEC2027.C100";
  const soldOptionTicker = "+SOLDOPT.19DEC2027.C100";
  globalThis.fetch = (_input, init) => {
    const command = new URLSearchParams(String(init?.body)).get("cmd");
    if (command === "getBrokerReport") return Promise.resolve(Response.json(fundedReport([{ i: "AAPL.US", q: 4, value: 800 }, { i: optionTicker, q: 2, value: 300 }], 525)));
    if (command === "getPositionJson") {
      return Promise.resolve(Response.json({ result: { ps: { pos: [
        { i: "AAPL.US", q: 4, s: 400, price_a: 100, mkt_price: 200, profit_close: 300, curr: "USD" },
        { i: optionTicker, q: 2, s: 200, price_a: 100, mkt_price: 150, profit_close: 80, curr: "USD" },
      ] } } }));
    }
    if (command === "getOrdersHistory") {
      const orders = [
        { instr: "AAPL.US", q: 4, p: 100, oper: 1 },
        { instr: optionTicker, q: 2, p: 100, oper: 1 },
        { instr: "SOLDSTK.US", q: 1, p: 50, oper: 1 },
        { instr: soldOptionTicker, q: 1, p: 50, oper: 1 },
        { instr: "SOLDSTK.US", q: 1, p: 75, oper: 3 },
        { instr: soldOptionTicker, q: 1, p: 100, oper: 3 },
      ].map((order, index) => ({ ...order, id: index + 1, date: index < 4 ? "2025-01-02" : "2025-02-02", stat: 21, curr: "USD" }));
      return Promise.resolve(Response.json({ orders: { order: orders } }));
    }
    return Promise.resolve(Response.json({ result: { q: [] } }));
  };
  try {
    ensureSchema(db);
    const h = harness(db);
    const owner = 123456789, recipient = 987654321;
    await h.command("/bucket new Core");
    createIntegration({ database: db, userId: owner, kind: "f24", credentials: { apiKey: "test-key", secretKey: "secret" } });
    for (const kind of ["perf", "worth", "dpnl", "alltime"]) {
      for (const filter of ["s", "stocks", "o", "options"]) {
        const callsBefore = h.calls.length;
        await h.command(`/${kind}@eyri_bot ${filter}`);
        ok(h.calls.length > callsBefore);
        const text = h.lastText();
        const stocks = filter === "s" || filter === "stocks";
        match(text, stocks ? /AAPL/ : /MSFT/, text);
        equal(text.includes(stocks ? "MSFT" : "AAPL"), false, text);
        if (kind === "alltime") {
          match(text, stocks ? /SOLDSTK/ : /SOLDOPT/, text);
          equal(text.includes(stocks ? "SOLDOPT" : "SOLDSTK"), false, text);
          match(text, stocks ? /Total: \+\$425\.00/ : /Total: \+\$150\.00/);
          match(text, /Lifetime return unavailable/);
          equal(text.includes("%"), false);
        } else if (kind === "worth") {
          match(text, stocks ? /Total: \+100\.00% \$800\.00/ : /Total: \+50\.00% \$300\.00/);
        } else if (kind === "dpnl") {
          match(text, stocks ? /\+\$100\.00 today/ : /\+\$20\.00 today/);
        } else {
          match(text, stocks ? /Total: \+100\.00% \+\$400\.00/ : /Total: \+50\.00% \+\$100\.00/);
        }
      }
    }
    for (const kind of ["perf", "worth", "dpnl"]) {
      await h.command(`/${kind}`);
      match(h.lastText(), /AAPL/);
      match(h.lastText(), /MSFT/);
    }
    for (const [kind, stocks, options] of [["perf", "+$400.00", "+$100.00"], ["alltime", "+$425.00", "+$150.00"],
      ["worth", "$800.00", "$300.00"], ["dpnl", "+$100.00", "+$20.00"]]) {
      for (const alias of ["s", "stocks", "o", "options"]) {
        await h.command(`/number ${kind} ${alias}`);
        equal(h.lastText().split("\n").at(-1), alias === "s" || alias === "stocks" ? stocks : options);
        equal(h.lastText().includes("Total:"), false);
      }
    }
    await h.command("/number worth");
    equal(h.lastText().split("\n").at(-1), "$1,100.00");
    await h.command("/number alltime");
    equal(h.lastText().split("\n").at(-1), "+$575.00");
    await h.command("/number dpnl");
    equal(h.lastText().split("\n").at(-1), "+$120.00");
    await h.command("/number o");
    match(h.lastText(), /\+\$100\.00$/);
    await h.command("/worthnumber s");
    match(h.lastText(), /\$800\.00$/);
    await h.command("/allnumber o");
    match(h.lastText(), /\+\$150\.00$/);
    for (const ticker of ["AAPL.US", optionTicker]) {
      db.prepare("INSERT INTO portfolio_bucket_transactions(user_id,transaction_key,bucket_name) VALUES (?,?,?)")
        .run(owner, JSON.stringify(["2025-01-02", ticker, "USD"]), "Core");
    }
    await h.command("/bucket transfer Core", owner, recipient);
    for (const kind of ["perf", "worth", "dpnl", "alltime"]) {
      for (const filter of ["stocks", "options"]) {
        await h.command(`/${kind} ${filter} Core`, recipient);
        match(h.lastText(), filter === "stocks" ? /AAPL/ : /MSFT/);
        equal(/SOLDOPT|SOLDSTK/.test(h.lastText()), false, h.lastText());
      }
    }
    await h.command("/perf options", owner);
    match(h.lastText(), /No positions/);
    await h.command("/perf stocks Missing");
    match(h.lastText(), /Bucket not found: Missing/);
    await h.command("/worth options bad-name");
    match(h.lastText(), /Bucket names must/);
    await h.command("/dpnl s Core extra");
    match(h.lastText(), /Use \/perf/);
    const callsBefore = h.calls.length;
    for (const command of ["/stocks", "/options", "/perf@another_bot stocks"]) {
      await h.command(command);
      equal(h.calls.length, callsBefore);
    }
  } finally {
    db.close();
    globalThis.fetch = previousFetch;
    if (previousPath === undefined) Deno.env.delete("EYRI_DATABASE_PATH");
    else Deno.env.set("EYRI_DATABASE_PATH", previousPath);
  }
});
