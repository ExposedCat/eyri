import { deepStrictEqual, equal, ok, rejects } from "node:assert/strict";
import { Database } from "@db/sqlite";
import { ensureSchema } from "../../database/setup.ts";
import { createIntegration, type Integration } from "../../database/integration.ts";
import { ibkrAdapter } from "./adapter.ts";
import { FlexReportPending, FlexServiceError, getFlexStatement, getFlexStatementRange, readFlexOrders } from "./flex.ts";
import { cacheIbkrFundingBatch, fetchIbkrAccountPerformance } from "./ledger.ts";
import { syncNextFlexBatch } from "./flex_sync.ts";

const now = new Date("2025-01-04T12:00:00Z");
const minute = 60_000;
const at = (minutes: number) => new Date(+now + minutes * minute);
const date = (value: Date) => value.toISOString().slice(0, 10).replaceAll("-", "");
const snapshot = { accountId: "U1", currency: "USD", cash: 100, totalValue: 100 };
function addIntegration(db: Database, token = "token", query = "trades", fundingQuery = "funding") {
  ensureSchema(db);
  db.exec("INSERT OR IGNORE INTO users(user_id) VALUES (1)");
  const result = createIntegration({ database: db, userId: 1, kind: "ibkr", credentials: {
    instanceUrl: "tcp://localhost:4001", flexToken: token, flexQueryId: query, fundingFlexQueryId: fundingQuery,
  } });
  ok(result.success);
  return result.data!;
}
function funding(range: { from: Date; to: Date }, opened = "20250101", trades = "") {
  const first = date(range.from) <= opened;
  const deposit = first ? 100 : 0;
  const from = date(range.from) > opened ? date(range.from) : opened;
  return `<FlexQueryResponse type="AF"><FlexStatement accountId="U1" fromDate="${from}" toDate="${date(range.to)}">
    <AccountInformation accountId="U1" currency="USD" dateOpened="${opened}" dateFunded="${opened}" />
    <CashTransactions>${first ? `<CashTransaction transactionID="deposit" currency="USD" amount="100" type="Deposit" reportDate="${opened}" />` : ""}</CashTransactions>
    <CashReport><CashReportCurrency currency="BASE_SUMMARY" deposits="${deposit}" withdrawals="0" startingCash="${first ? 0 : 100}" endingCash="100" />
    <CashReportCurrency currency="USD" deposits="${deposit}" withdrawals="0" startingCash="${first ? 0 : 100}" endingCash="100" /></CashReport>
    <ChangeInNAV depositsWithdrawals="${deposit}" startingValue="${first ? 0 : 100}" />
    <Trades>${trades}</Trades></FlexStatement></FlexQueryResponse>`;
}
const trade = (day = "20250101", commission = true) => `<Trade symbol="A" tradeDate="${day}" quantity="2" buySell="BUY" tradePrice="10" currency="USD" assetCategory="STK" ${commission ? 'ibCommission="-1" ibCommissionCurrency="USD"' : ""} />`;
const trades = (body = "") => `<FlexQueryResponse><Trades>${body}</Trades></FlexQueryResponse>`;
function legacyTrade(db: Database, integration: Integration) {
  readFlexOrders(db, integration);
  db.prepare("INSERT INTO ibkr_flex_trades(integration_id,query_id,trade_key,ticker,date,quantity,price,currency,asset_category,synced_at) VALUES(?,?,'legacy','A','2023-01-01',2,10,'USD','STK','2023-01-02')")
    .run(integration.id, integration.credentials.flexQueryId as string);
}

Deno.test("funding and commission report reads never fetch Flex, even on a cold cache", async () => {
  const db = new Database(":memory:");
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = () => { calls++; throw new Error("Report attempted a network request"); };
  try {
    const integration = addIntegration(db);
    legacyTrade(db, integration);
    for (let index = 0; index < 3; index++) {
      equal((await ibkrAdapter.fetchOrderHistory(db, integration)).length, 1);
      await rejects(fetchIbkrAccountPerformance(db, integration, snapshot, now), /syncing in the background/);
    }
    cacheIbkrFundingBatch(db, integration, getFlexStatementRange(0, now), funding(getFlexStatementRange(0, now)), now);
    // A cache remains readable across both TTL expiration and UTC day rollover.
    const result = await fetchIbkrAccountPerformance(db, integration, snapshot, at(2 * 24 * 60));
    equal(result.deposits, 100);
    equal(result.historyThrough.toISOString().slice(0, 10), "2025-01-03");
    equal(calls, 0);
  } finally { globalThis.fetch = original; db.close(); }
});

Deno.test("one generated statement populates both trade and funding caches on the shared polling cadence", async () => {
  const db = new Database(":memory:");
  try {
    const integration = addIntegration(db, "token", "combined", "combined");
    let calls = 0;
    const requestStatement: typeof getFlexStatement = (_token, _query, range) => {
      calls++;
      return Promise.resolve(funding(range, "20250101", trade()));
    };
    equal(await syncNextFlexBatch(db, { now, maxYears: 1, requestStatement }), true);
    equal(calls, 1);
    equal(readFlexOrders(db, integration).length, 1);
    equal((await fetchIbkrAccountPerformance(db, integration, snapshot, now)).deposits, 100);
    equal(await syncNextFlexBatch(db, { now: at(4), maxYears: 1, requestStatement }), false);
    equal(calls, 1);
    equal(await syncNextFlexBatch(db, { now: at(5), maxYears: 1, requestStatement }), true);
    equal(calls, 2);
  } finally { db.close(); }
});

Deno.test("funding backfill discovers and imports annual ranges one report per poll until lifetime history is complete", async () => {
  const db = new Database(":memory:");
  try {
    const integration = addIntegration(db);
    const ranges: string[][] = [];
    const requestStatement: typeof getFlexStatement = (_token, query, range) => {
      equal(query, "funding");
      ranges.push([date(range.from), date(range.to)]);
      return Promise.resolve(funding(range, "20230101"));
    };
    await syncNextFlexBatch(db, { now, maxYears: 1, requestStatement });
    await rejects(fetchIbkrAccountPerformance(db, integration, snapshot, now), /syncing in the background/);
    for (const minutes of [5, 10, 15]) await syncNextFlexBatch(db, { now: at(minutes), maxYears: 1, requestStatement });
    deepStrictEqual(ranges, [
      ["20240105", "20250103"], ["20241231", "20250103"], ["20240101", "20241230"], ["20230101", "20231231"],
    ]);
    equal((await fetchIbkrAccountPerformance(db, integration, snapshot, now)).deposits, 100);
  } finally { db.close(); }
});

Deno.test("legacy commissions backfill in the background while reads preserve fills and their bucket identity", async () => {
  const db = new Database(":memory:");
  try {
    const integration = addIntegration(db);
    legacyTrade(db, integration);
    const requests: string[][] = [];
    const requestStatement: typeof getFlexStatement = (_token, query, range) => {
      requests.push([query, date(range.from), date(range.to)]);
      return Promise.resolve(query === "funding" ? funding(range) : trades(date(range.from) === "20230101" ? trade("20230101") : ""));
    };
    for (const minutes of [0, 5, 10]) await syncNextFlexBatch(db, { now: at(minutes), maxYears: 1, requestStatement });
    equal(requests.length, 3);
    deepStrictEqual(requests[2], ["trades", "20230101", "20230101"]);
    const result = await ibkrAdapter.fetchOrderHistory(db, integration);
    equal(result.length, 1);
    equal(result[0].date.toISOString().slice(0, 10), "2023-01-01");
    deepStrictEqual(result[0].commission, { amount: -1, currency: "USD" });
    equal(requests.length, 3);
  } finally { db.close(); }
});

Deno.test("1025 pauses every query sharing the token across restarts while other tokens continue", async () => {
  const path = Deno.makeTempFileSync({ suffix: ".sqlite" });
  let db = new Database(path);
  try {
    addIntegration(db, "blocked", "trades-1", "funding-1");
    addIntegration(db, "blocked", "trades-2", "funding-2");
    addIntegration(db, "healthy", "trades-3", "funding-3");
    const tokens: string[] = [];
    const requestStatement: typeof getFlexStatement = (token, query, range) => {
      tokens.push(token);
      if (token === "blocked") return Promise.reject(new FlexServiceError("IBKR Flex report generation failed (1025): Too many failed attempts.", "1025"));
      return Promise.resolve(query.startsWith("funding") ? funding(range) : trades());
    };
    await syncNextFlexBatch(db, { now, maxYears: 1, requestStatement });
    db.close();
    db = new Database(path);
    for (const minutes of [5, 10, 20, 59]) await syncNextFlexBatch(db, { now: at(minutes), maxYears: 1, requestStatement });
    equal(tokens.filter(token => token === "blocked").length, 1);
    ok(tokens.includes("healthy"));
    await syncNextFlexBatch(db, { now: at(65), maxYears: 1, requestStatement });
    equal(tokens.filter(token => token === "blocked").length, 2);
    const pause = db.prepare("SELECT MAX(next_attempt_at) AS until FROM ibkr_flex_poll_tokens").get() as { until: number };
    equal(pause.until, +at(185));
  } finally { db.close(); Deno.removeSync(path); }
});

Deno.test("pending reports retain their reference across restarts instead of submitting a new generation", async () => {
  const path = Deno.makeTempFileSync({ suffix: ".sqlite" });
  let db = new Database(path);
  try {
    addIntegration(db, "token", "combined", "combined");
    const references: (string | undefined)[] = [];
    const requestStatement: typeof getFlexStatement = (_token, _query, range, _fetch, _sleep, _clock, progress) => {
      references.push(progress?.referenceCode);
      if (references.length === 1) {
        progress?.onReference?.("pending-reference");
        return Promise.reject(new FlexReportPending("pending-reference"));
      }
      equal(progress?.referenceCode, "pending-reference");
      return Promise.resolve(funding(range));
    };
    await syncNextFlexBatch(db, { now, maxYears: 1, requestStatement });
    db.close(); db = new Database(path);
    await syncNextFlexBatch(db, { now: at(5), maxYears: 1, requestStatement });
    deepStrictEqual(references, [undefined, "pending-reference"]);
    equal(db.prepare("SELECT COUNT(*) AS count FROM ibkr_flex_poll_tokens").get()!.count, 0);
  } finally { db.close(); Deno.removeSync(path); }
});

Deno.test("concurrent pollers share a durable lease and cannot generate duplicate reports", async () => {
  const path = Deno.makeTempFileSync({ suffix: ".sqlite" });
  const first = new Database(path), second = new Database(path);
  try {
    addIntegration(first, "token", "combined", "combined");
    let calls = 0;
    let release!: (value: string) => void;
    const requestStatement: typeof getFlexStatement = () => {
      calls++;
      return new Promise(resolve => { release = resolve; });
    };
    const pending = syncNextFlexBatch(first, { now, maxYears: 1, requestStatement });
    equal(await syncNextFlexBatch(second, { now, maxYears: 1, requestStatement }), false);
    equal(calls, 1);
    release(funding(getFlexStatementRange(0, now)));
    equal(await pending, true);
  } finally { first.close(); second.close(); Deno.removeSync(path); }
});

Deno.test("failed or malformed refreshes preserve the last good cache and enforce retry cooldowns", async () => {
  const db = new Database(":memory:");
  try {
    const integration = addIntegration(db, "token", "combined", "combined");
    let calls = 0;
    const requestStatement: typeof getFlexStatement = (_token, _query, range) => {
      calls++;
      if (calls === 1) return Promise.resolve(funding(range, "20250101", trade()));
      return Promise.resolve("<html>upstream error</html>");
    };
    await syncNextFlexBatch(db, { now, maxYears: 1, requestStatement });
    await syncNextFlexBatch(db, { now: at(5), maxYears: 1, requestStatement });
    equal(readFlexOrders(db, integration).length, 1);
    equal((await fetchIbkrAccountPerformance(db, integration, snapshot, at(5))).deposits, 100);
    equal(await syncNextFlexBatch(db, { now: at(10), maxYears: 1, requestStatement }), false);
    equal(calls, 2);
  } finally { db.close(); }
});

Deno.test("deployment respects previously recorded 1025 failures from the old trade sync", async () => {
  const db = new Database(":memory:");
  try {
    const integration = addIntegration(db);
    readFlexOrders(db, integration);
    db.prepare("INSERT INTO ibkr_flex_sync_batches VALUES (?, 'trades',0,'2024-01-05','2025-01-03',?,NULL,?)")
      .run(integration.id, at(-2).toISOString(), "IBKR Flex report generation failed (1025): Too many failed attempts.");
    let calls = 0;
    const requestStatement: typeof getFlexStatement = () => { calls++; throw new Error("Unexpected request"); };
    equal(await syncNextFlexBatch(db, { now, maxYears: 1, requestStatement }), false);
    equal(await syncNextFlexBatch(db, { now: at(30), maxYears: 1, requestStatement }), false);
    equal(calls, 0);
  } finally { db.close(); }
});

Deno.test("transient failures back off without command retries and reset after a successful poll", async () => {
  const db = new Database(":memory:");
  try {
    const integration = addIntegration(db, "token", "combined", "combined");
    let calls = 0;
    const requestStatement: typeof getFlexStatement = (_token, _query, range) => {
      calls++;
      if (calls < 3) return Promise.reject(new FlexServiceError("IBKR Flex report generation failed (1001): not ready", "1001"));
      return Promise.resolve(funding(range));
    };
    await syncNextFlexBatch(db, { now, maxYears: 1, requestStatement });
    await syncNextFlexBatch(db, { now: at(5), maxYears: 1, requestStatement });
    equal(await syncNextFlexBatch(db, { now: at(10), maxYears: 1, requestStatement }), false);
    equal(calls, 2);
    await syncNextFlexBatch(db, { now: at(15), maxYears: 1, requestStatement });
    equal(calls, 3);
    equal((await fetchIbkrAccountPerformance(db, integration, snapshot, at(15))).deposits, 100);
    equal(db.prepare("SELECT COUNT(*) AS count FROM ibkr_flex_poll_tokens").get()!.count, 0);
  } finally { db.close(); }
});

Deno.test("a failed next-day funding refresh keeps the previous statement usable for perf benchmarks", async () => {
  const db = new Database(":memory:");
  try {
    const integration = addIntegration(db, "token", "combined", "combined");
    await syncNextFlexBatch(db, { now, maxYears: 1, requestStatement: (_token, _query, range) => Promise.resolve(funding(range)) });
    const tomorrow = at(24 * 60);
    await syncNextFlexBatch(db, { now: tomorrow, maxYears: 1, requestStatement: () => Promise.reject(new FlexServiceError("Too many failed attempts.", "1025")) });
    const live = { ...snapshot, cash: 50 };
    const result = await fetchIbkrAccountPerformance(db, integration, live, tomorrow, { purpose: "benchmark" });
    equal(result.historyThrough.toISOString().slice(0, 10), "2025-01-03");
    equal(result.deposits, 100);
    await rejects(fetchIbkrAccountPerformance(db, integration, live, tomorrow), /today's cash activity/);
  } finally { db.close(); }
});
