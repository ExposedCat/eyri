import { deepStrictEqual, equal, match, ok } from "node:assert/strict";
import { createHash } from "node:crypto";
import { Database } from "@db/sqlite";
import { Bot } from "grammy";
import type { Update } from "grammy_types";
import type { Bot as EyriBot, CustomContext } from "../bot/types.ts";
import { setupBotCommands } from "../bot/setup.ts";
import { ensureSchema } from "../database/setup.ts";
import { createIntegration } from "../database/integration.ts";
import { cacheIbkrFundingBatch, getIbkrFundingSyncRanges } from "../integrations/ibkr/ledger.ts";
import { getAdminId } from "./access.ts";
import { createStatusComposer, statusMessages } from "./composer.ts";
import { collectConnectorStatus, type ConnectorStatus, type StatusReport } from "./service.ts";

const now = Date.parse("2026-10-31T12:00:00Z");
const add = (db: Database, userId: number, kind: "ibkr" | "t212" | "f24", credentials: Record<string, unknown> = {}) => {
  db.prepare("INSERT OR IGNORE INTO users(user_id) VALUES (?)").run(userId);
  const result = createIntegration({ database: db, userId, kind, credentials });
  ok(result.success);
  return result.data!;
};
const ibkr = { instanceUrl: "tcp://ib_gateway_2:4003", flexToken: "private-flex-token", flexQueryId: "trades", fundingFlexQueryId: "funding" };

Deno.test("status includes every owner's brokers and separates blocked Gateway login from Flex and healthy APIs", async () => {
  const db = new Database(":memory:");
  try {
    ensureSchema(db);
    const blocked = add(db, 1, "ibkr", ibkr);
    const healthy = add(db, 2, "ibkr", { ...ibkr, instanceUrl: "tcp://ib_gateway:4003" });
    const t212 = add(db, 3, "t212", { apiKey: "t212-key", secretKey: "t212-secret" });
    const f24 = add(db, 4, "f24", { apiKey: "f24-key", secretKey: "f24-secret" });
    db.exec(`CREATE TABLE ibkr_flex_poll_jobs(integration_id INTEGER,kind TEXT,query_id TEXT,job_key TEXT,synced_at REAL,next_attempt_at REAL,last_error TEXT,reference_code TEXT);
      CREATE TABLE ibkr_flex_poll_tokens(token_hash TEXT,next_attempt_at REAL,last_error TEXT);
      CREATE TABLE trading212_history_sync(integration_id INTEGER,synced_at INTEGER);`);
    db.prepare("INSERT INTO ibkr_flex_poll_jobs VALUES (?,'trades','trades','0',?,?,?,NULL)").run(blocked.id, now - 100_000, now + 30_000, "IBKR 1025: Too many failed attempts.");
    db.prepare("INSERT INTO ibkr_flex_poll_jobs VALUES (?,'funding','funding','2025-10-31:2026-10-30',NULL,?,NULL,'pending-ref')").run(blocked.id, now + 30_000);
    db.prepare("INSERT INTO ibkr_flex_poll_tokens VALUES (?,?,?)").run(createHash("sha256").update(ibkr.flexToken).digest("hex"), now + 3_600_000, "1025: Too many failed attempts.");
    db.prepare("INSERT INTO trading212_history_sync VALUES (?,?)").run(t212.id, now - 10_000);
    const probes: number[] = [];
    const report = await collectConnectorStatus(db, {
      now: () => now,
      gateway: host => Promise.resolve(host === "ib_gateway_2"
        ? { state: "blocked", message: "Gateway login HALTED; authentication needs attention" }
        : { state: "ready", message: "Gateway ready" }),
      probe: integration => {
        probes.push(integration.id);
        return integration.id === f24.id ? Promise.reject(new Error("HTTP 403")) : Promise.resolve();
      },
    });
    deepStrictEqual(report.connectors.map(connector => connector.ownerId), [1, 2, 3, 4]);
    equal(report.connectors[0].state, "blocked");
    equal(report.connectors[0].endpoint, "ib_gateway_2:4003");
    ok(!probes.includes(blocked.id));
    ok(probes.includes(healthy.id));
    equal(report.connectors[0].checks.find(check => check.name === "Flex token")!.nextAttempt, now + 3_600_000);
    equal(report.connectors[0].checks.find(check => check.name === "Flex trades")!.nextAttempt, now + 3_600_000);
    equal(report.connectors[2].checks.find(check => check.name === "Order history")!.lastSuccess, now - 10_000);
    equal(report.connectors[3].state, "offline");
    const text = statusMessages(report).join("\n");
    for (const name of ["IBKR", "Trading 212", "Freedom24", "HALTED", "1025", "owner 4", "2026-10-31 13:00:00 UTC"]) ok(text.includes(name));
    ok(!text.includes("pending-ref"));
  } finally { db.close(); }
});

Deno.test("diagnostics redact raw, encoded and Basic credentials and escape HTML", async () => {
  const db = new Database(":memory:");
  try {
    ensureSchema(db);
    const key = "my-private-api-key", secret = "secret/value&";
    add(db, 1, "f24", { apiKey: key, secretKey: secret });
    const report = await collectConnectorStatus(db, {
      probe: () => Promise.reject(new Error(`<b>failure</b> ${key} ${secret} ${encodeURIComponent(secret)} Basic ${btoa(`${key}:${secret}`)}`)),
    });
    const text = statusMessages(report).join("\n");
    for (const credential of [key, secret, encodeURIComponent(secret), btoa(`${key}:${secret}`)]) ok(!text.includes(credential));
    match(text, /\[redacted\]/);
    match(text, /&lt;b&gt;failure&lt;\/b&gt;/);
  } finally { db.close(); }
});

Deno.test("a stalled or misconfigured connector does not hide other connectors and health checks are deduplicated", async () => {
  const db = new Database(":memory:");
  try {
    ensureSchema(db);
    add(db, 1, "ibkr", ibkr);
    add(db, 2, "ibkr", ibkr);
    add(db, 3, "t212");
    add(db, 4, "ibkr");
    let healthCalls = 0;
    const report = await collectConnectorStatus(db, {
      timeoutMs: 5,
      gateway: () => { healthCalls++; return Promise.resolve({ state: "unknown", message: "Legacy gateway" }); },
      probe: integration => integration.kind === "t212" ? new Promise(() => {}) : Promise.resolve(),
    });
    equal(healthCalls, 1);
    equal(report.connectors.length, 4);
    equal(report.connectors[2].state, "offline");
    match(report.connectors[2].checks[0].message!, /timed out/);
    equal(report.connectors[3].state, "offline");
  } finally { db.close(); }
});

Deno.test("a recovered connector ignores errors on superseded funding ranges", async () => {
  const db = new Database(":memory:");
  try {
    ensureSchema(db);
    const integration = add(db, 1, "ibkr", ibkr);
    const range = getIbkrFundingSyncRanges(db, integration, new Date(now))[0];
    const day = (date: Date) => date.toISOString().slice(0, 10).replaceAll("-", "");
    cacheIbkrFundingBatch(db, integration, range, `<FlexQueryResponse type="AF"><FlexStatement accountId="U1" fromDate="${day(range.from)}" toDate="${day(range.to)}">
      <AccountInformation currency="USD" dateOpened="20251031" />
      <CashTransactions><CashTransaction transactionID="deposit" currency="USD" amount="100" type="Deposit" reportDate="20251031" /></CashTransactions>
      <CashReportCurrency currency="USD" startingCash="0" endingCash="100" deposits="100" withdrawals="0" />
      <ChangeInNAV startingValue="0" depositsWithdrawals="100" />
    </FlexStatement></FlexQueryResponse>`, new Date(now));
    db.exec("CREATE TABLE ibkr_flex_poll_jobs(integration_id INTEGER,kind TEXT,query_id TEXT,job_key TEXT,synced_at REAL,next_attempt_at REAL,last_error TEXT,reference_code TEXT)");
    db.prepare("INSERT INTO ibkr_flex_poll_jobs VALUES (?,'funding','funding','2025-10-30:2026-10-29',NULL,?,'obsolete failure',NULL)").run(integration.id, now);
    for (const [kind, query, key] of [["funding", "funding", `${range.from.toISOString().slice(0, 10)}:${range.to.toISOString().slice(0, 10)}`], ["trades", "trades", "0"]]) {
      db.prepare("INSERT INTO ibkr_flex_poll_jobs VALUES (?,?,?,?,?,?,NULL,NULL)").run(integration.id, kind, query, key, now, now + 300_000);
    }
    const report = await collectConnectorStatus(db, { now: () => now, probe: () => Promise.resolve(), gateway: () => Promise.resolve({ state: "ready", message: "Ready" }) });
    equal(report.connectors[0].state, "healthy");
    ok(!statusMessages(report).join("\n").includes("obsolete failure"));
  } finally { db.close(); }
});

function harness(adminId: number | undefined, collect: typeof collectConnectorStatus) {
  const calls: { method: string; payload: Record<string, unknown> }[] = [];
  const db = new Database(":memory:");
  const bot = new Bot<CustomContext>("123:test", { botInfo: {
    id: 123, is_bot: true, first_name: "Eyri", username: "eyri_bot", can_join_groups: true, can_read_all_group_messages: false,
    supports_inline_queries: false, can_connect_to_business: false, has_main_web_app: false,
  } });
  bot.api.config.use((_previous, method, payload) => {
    calls.push({ method, payload: payload as unknown as Record<string, unknown> });
    return Promise.resolve({ ok: true, result: { message_id: 1, date: 1, chat: { id: 1, type: "private" }, text: "mock" } }) as never;
  });
  bot.use(async (ctx, next) => { ctx.db = db; await next(); });
  bot.use(createStatusComposer({ adminId: () => adminId, collect }));
  let update = 0;
  return { db, calls, command: (userId = 1, chatType = "private", chatId = userId) => bot.handleUpdate({
    update_id: ++update,
    message: { message_id: update, date: 1, from: { id: userId, is_bot: false, first_name: "User" },
      chat: { id: chatId, type: chatType }, text: "/status@eyri_bot", entities: [{ type: "bot_command", offset: 0, length: 16 }] },
  } as Update) };
}

Deno.test("/status authorizes the sender against ADMIN_ID, fails closed, and restricts global reports to private chat", async () => {
  let checked = 0;
  const collect = () => { checked++; return Promise.resolve({ checkedAt: now, connectors: [] }); };
  for (const adminId of [undefined, 1]) {
    const h = harness(adminId, collect);
    try {
      await h.command(2, "private", 1); // A chat ID matching the admin does not grant access.
      match(String(h.calls.at(-1)!.payload.text), /Admin only/);
      if (adminId) {
        await h.command(1, "group", -100);
        match(String(h.calls.at(-1)!.payload.text), /private chat/);
      } else await h.command(1);
      equal(checked, 0);
      if (adminId) {
        await h.command(1);
        equal(checked, 1);
        match(String(h.calls.at(-1)!.payload.text), /No broker connectors/);
      }
    } finally { h.db.close(); }
  }
});

Deno.test("/status splits long reports into valid messages and preserves every connector", async () => {
  const connectors: ConnectorStatus[] = Array.from({ length: 40 }, (_, index) => ({
    integrationId: index + 1, ownerId: index + 1000, kind: "ibkr", state: "blocked", endpoint: `gateway-${index}:4003`,
    checks: [{ name: "Gateway", state: "error", message: "<&>".repeat(100) }, { name: "Flex", state: "error", message: "Unavailable ".repeat(35) }],
  }));
  const report: StatusReport = { checkedAt: now, connectors };
  const h = harness(1, () => Promise.resolve(report));
  try {
    await h.command();
    ok(h.calls.length > 1);
    for (const call of h.calls) {
      equal(call.payload.parse_mode, "HTML");
      ok(String(call.payload.text).length < 4096);
      ok(!String(call.payload.text).includes("<&>"));
    }
    const text = h.calls.map(call => call.payload.text).join("\n");
    for (const connector of connectors) ok(text.includes(`<b>IBKR #${connector.integrationId}</b>`));
  } finally { h.db.close(); }
});

Deno.test("ADMIN_ID parsing rejects malformed values and registers /status only in the admin's private menu", async () => {
  for (const value of ["", "1,2", "-1", "1e3", "123oops", "0", "9007199254740992"]) equal(getAdminId(value), undefined);
  equal(getAdminId(" 123456789 "), 123456789);
  const previous = Deno.env.get("ADMIN_ID");
  try {
    Deno.env.set("ADMIN_ID", "123456789");
    const calls: unknown[][] = [];
    await setupBotCommands({ api: { setMyCommands: (...args: unknown[]) => { calls.push(args); return Promise.resolve(true); } } } as unknown as EyriBot);
    ok(!(calls[0][0] as { command: string }[]).some(command => command.command === "status"));
    ok((calls[1][0] as { command: string }[]).some(command => command.command === "status"));
    deepStrictEqual(calls[1][1], { scope: { type: "chat", chat_id: 123456789 } });
  } finally {
    if (previous === undefined) Deno.env.delete("ADMIN_ID"); else Deno.env.set("ADMIN_ID", previous);
  }
});
