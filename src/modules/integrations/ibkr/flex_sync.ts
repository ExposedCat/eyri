import { createHash } from "node:crypto";
import { getAllIntegrations, type Integration } from "../../database/integration.ts";
import type { Database } from "../../database/setup.ts";
import { parseIbkrCredentials } from "./credentials.ts";
import {
  cacheFlexCommissions, ensureFlexSchema, FlexReportPending, FlexServiceError, getFlexCommissionRange,
  getFlexMaxYears, getFlexStatement, getFlexStatementRange, parseTrades,
  type FlexStatementRange, writeBatchTrades,
} from "./flex.ts";
import { cacheIbkrFundingBatch, getIbkrFundingSyncRanges } from "./ledger.ts";

const interval = 5 * 60_000;
const hour = 3_600_000;
const day = 24 * hour;
type Kind = "trades" | "funding" | "commissions";
type Work = {
  integration: Integration;
  kind: Kind;
  queryId: string;
  key: string;
  token: string;
  tokenHash: string;
  credentialKey: string;
  range: FlexStatementRange;
  refresh: number;
  priority: number;
  seedRequested?: number;
  seedSynced?: number;
};
type Job = { requested_at: number | null; next_attempt_at: number; failures: number };
type Runtime = { requestStatement?: typeof getFlexStatement; now?: Date; maxYears?: number };
const date = (value: Date) => value.toISOString().slice(0, 10);
const digest = (value: string) => createHash("sha256").update(value).digest("hex");

function ensureSchema(database: Database) {
  ensureFlexSchema(database);
  database.exec(`
    CREATE TABLE IF NOT EXISTS ibkr_flex_poll_jobs (
      integration_id INTEGER NOT NULL, kind TEXT NOT NULL, query_id TEXT NOT NULL,
      job_key TEXT NOT NULL, credential_key TEXT NOT NULL,
      from_date TEXT NOT NULL, to_date TEXT NOT NULL,
      requested_at REAL, synced_at REAL, reference_code TEXT, next_attempt_at REAL NOT NULL DEFAULT 0,
      failures INTEGER NOT NULL DEFAULT 0, last_error TEXT,
      PRIMARY KEY (integration_id,kind,query_id,job_key));
    CREATE TABLE IF NOT EXISTS ibkr_flex_poll_tokens (
      token_hash TEXT PRIMARY KEY, next_attempt_at REAL NOT NULL DEFAULT 0,
      failures INTEGER NOT NULL DEFAULT 0, last_error TEXT);
    CREATE TABLE IF NOT EXISTS ibkr_flex_poll_state (
      id INTEGER PRIMARY KEY CHECK(id=1), next_poll_at REAL NOT NULL, lease_until REAL NOT NULL);
    INSERT OR IGNORE INTO ibkr_flex_poll_state VALUES (1,0,0);
  `);
}

function planWork(database: Database, now: Date, maxYears: number) {
  const work: Work[] = [];
  for (const integration of getAllIntegrations(database)) {
    if (integration.kind !== "ibkr") continue;
    try {
      const credentials = parseIbkrCredentials(integration.credentials);
      const token = credentials.flexToken;
      if (!token) continue;
      const tokenHash = digest(token);
      const credentialKey = digest(JSON.stringify([token, credentials.accountId]));
      const add = (kind: Kind, queryId: string, key: string, range: FlexStatementRange, refresh: number, priority: number) => {
        const item: Work = { integration, kind, queryId, key, range, refresh, priority, token, tokenHash, credentialKey };
        work.push(item);
        return item;
      };
      if (credentials.flexQueryId) {
        for (let index = 0; index < maxYears; index++) {
          const range = getFlexStatementRange(index, now);
          const legacy = database.prepare("SELECT from_date,to_date,requested_at,synced_at,last_error FROM ibkr_flex_sync_batches WHERE integration_id=? AND query_id=? AND batch_index=?")
            .get(integration.id, credentials.flexQueryId, index) as {
              from_date: string; to_date: string; requested_at: string | null; synced_at: string | null; last_error: string | null;
            } | undefined;
          const item = add("trades", credentials.flexQueryId, String(index), range, index === 0 ? interval : day, index === 0 ? 1 : 4);
          if (legacy) {
            item.seedRequested = legacy.requested_at ? +new Date(legacy.requested_at) : undefined;
            if (legacy.from_date === date(range.from) && legacy.to_date === date(range.to)) {
              item.seedSynced = legacy.synced_at ? +new Date(legacy.synced_at) : undefined;
            }
            // Carry existing lockouts into the new scheduler instead of issuing
            // another request immediately after deployment or a process restart.
            if (legacy.last_error?.includes("(1025)") && item.seedRequested && item.seedRequested + hour > +now) {
              database.prepare(`INSERT INTO ibkr_flex_poll_tokens(token_hash,next_attempt_at,failures,last_error) VALUES (?,?,1,?)
                ON CONFLICT(token_hash) DO UPDATE SET next_attempt_at=MAX(next_attempt_at,excluded.next_attempt_at)`)
                .run(tokenHash, item.seedRequested + hour, legacy.last_error.replaceAll(token, "[redacted]"));
            }
          }
          database.prepare(`INSERT INTO ibkr_flex_sync_batches(integration_id,query_id,batch_index,from_date,to_date) VALUES (?,?,?,?,?)
            ON CONFLICT(integration_id,query_id,batch_index) DO UPDATE SET from_date=excluded.from_date,to_date=excluded.to_date`)
            .run(integration.id, credentials.flexQueryId, index, date(range.from), date(range.to));
        }
        const missing = getFlexCommissionRange(database, integration, now);
        if (missing) add("commissions", credentials.flexQueryId, `${date(missing.from)}:${date(missing.to)}`, missing, hour, 3);
      }
      const fundingQuery = credentials.fundingFlexQueryId ?? credentials.flexQueryId;
      if (fundingQuery) {
        const latest = getFlexStatementRange(0, now).to;
        for (const range of getIbkrFundingSyncRanges(database, integration, now)) {
          const item = add("funding", fundingQuery, `${date(range.from)}:${date(range.to)}`, range, +range.to === +latest ? day : 7 * day, 0);
          const cached = database.prepare("SELECT payload,fetched_at FROM ibkr_funding_batches WHERE integration_id=? AND query_id=? AND from_date=? AND to_date=?")
            .get(integration.id, fundingQuery, range.from.toISOString(), range.to.toISOString()) as { payload: string; fetched_at: number } | undefined;
          if (cached && Array.isArray(JSON.parse(cached.payload).cashHistory)) item.seedSynced = cached.fetched_at;
        }
      }
    } catch (error) {
      console.error(`Cannot plan IBKR Flex integration=${integration.id}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return work;
}

function jobArgs(work: Work) {
  return [work.integration.id, work.kind, work.queryId, work.key] as const;
}

function registerJob(database: Database, work: Work) {
  database.prepare(`INSERT INTO ibkr_flex_poll_jobs
    (integration_id,kind,query_id,job_key,credential_key,from_date,to_date,requested_at,synced_at,next_attempt_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(integration_id,kind,query_id,job_key) DO UPDATE SET
      synced_at=CASE WHEN credential_key<>excluded.credential_key OR from_date<>excluded.from_date OR to_date<>excluded.to_date THEN NULL ELSE synced_at END,
      requested_at=CASE WHEN credential_key<>excluded.credential_key THEN NULL ELSE requested_at END,
      reference_code=CASE WHEN credential_key<>excluded.credential_key OR from_date<>excluded.from_date OR to_date<>excluded.to_date THEN NULL ELSE reference_code END,
      next_attempt_at=CASE WHEN credential_key<>excluded.credential_key THEN 0 ELSE next_attempt_at END,
      failures=CASE WHEN credential_key<>excluded.credential_key THEN 0 ELSE failures END,
      last_error=CASE WHEN credential_key<>excluded.credential_key THEN NULL ELSE last_error END,
      credential_key=excluded.credential_key,from_date=excluded.from_date,to_date=excluded.to_date`)
    .run(...jobArgs(work), work.credentialKey, date(work.range.from), date(work.range.to), work.seedRequested ?? null,
      work.seedSynced ?? null, Math.max((work.seedRequested ?? -interval) + interval, (work.seedSynced ?? -work.refresh) + work.refresh));
  return database.prepare("SELECT requested_at,next_attempt_at,failures FROM ibkr_flex_poll_jobs WHERE integration_id=? AND kind=? AND query_id=? AND job_key=?")
    .get(...jobArgs(work)) as Job;
}

function retryDelay(code: string | null, failures: number, token = false) {
  const exponential = interval * 2 ** Math.min(failures - 1, 8);
  if (code === "1025") return Math.min(day, hour * 2 ** Math.min(failures - 1, 5));
  if (["1011", "1012", "1013", "1015"].includes(code ?? "")) return Math.max(6 * hour, Math.min(day, exponential));
  if (!token && ["1010", "1014", "1016", "1020"].includes(code ?? "")) return Math.max(6 * hour, Math.min(day, exponential));
  return Math.min(6 * hour, exponential);
}

function failJob(database: Database, work: Work, now: Date, message: string, code: string | null, validation = false, notBefore = 0) {
  const row = database.prepare("SELECT failures FROM ibkr_flex_poll_jobs WHERE integration_id=? AND kind=? AND query_id=? AND job_key=?")
    .get(...jobArgs(work)) as { failures: number };
  const failures = row.failures + 1;
  const delay = validation ? Math.max(hour, retryDelay(code, failures)) : retryDelay(code, failures);
  const retryAt = Math.max(+now + delay, notBefore);
  database.prepare("UPDATE ibkr_flex_poll_jobs SET failures=?,last_error=?,next_attempt_at=? WHERE integration_id=? AND kind=? AND query_id=? AND job_key=?")
    .run(failures, message, retryAt, ...jobArgs(work));
  if (work.kind === "trades") database.prepare("UPDATE ibkr_flex_sync_batches SET last_error=? WHERE integration_id=? AND query_id=? AND batch_index=?")
    .run(message, work.integration.id, work.queryId, Number(work.key));
  console.error(`Failed to poll IBKR Flex ${work.kind} integration=${work.integration.id}; retry after ${new Date(retryAt).toISOString()}: ${message}`);
}

// One report generation per poll across all query types, with a durable lease
// and token-wide failure cooldown shared by separate processes and restarts.
export async function syncNextFlexBatch(database: Database, runtime: Runtime = {}) {
  ensureSchema(database);
  const now = runtime.now ?? new Date();
  const work = planWork(database, now, runtime.maxYears ?? getFlexMaxYears());
  const candidates = work.map(item => ({ item, state: registerJob(database, item) }));
  let group: Work[] = [];
  database.exec("BEGIN IMMEDIATE");
  try {
    const state = database.prepare("SELECT next_poll_at,lease_until FROM ibkr_flex_poll_state WHERE id=1").get() as { next_poll_at: number; lease_until: number };
    if (state.next_poll_at <= +now && state.lease_until <= +now) {
      const due = candidates.filter(({ item, state }) => {
        const token = database.prepare("SELECT next_attempt_at FROM ibkr_flex_poll_tokens WHERE token_hash=?").get(item.tokenHash) as { next_attempt_at: number } | undefined;
        return state.next_attempt_at <= +now && (!token || token.next_attempt_at <= +now);
      }).sort((a, b) => (a.state.requested_at ?? 0) - (b.state.requested_at ?? 0) || a.item.priority - b.item.priority || a.item.integration.id - b.item.integration.id);
      const first = due[0]?.item;
      if (first) {
        // A trade query can also contain funding. Reuse its generated report
        // for every due consumer of that exact token/query/date range.
        group = due.map(candidate => candidate.item).filter(item =>
          item.tokenHash === first.tokenHash && item.queryId === first.queryId &&
          +item.range.from === +first.range.from && +item.range.to === +first.range.to);
        database.prepare("UPDATE ibkr_flex_poll_state SET next_poll_at=?,lease_until=? WHERE id=1").run(+now + interval, +now + interval);
        for (const item of group) {
          database.prepare("UPDATE ibkr_flex_poll_jobs SET requested_at=? WHERE integration_id=? AND kind=? AND query_id=? AND job_key=?").run(+now, ...jobArgs(item));
          if (item.kind === "trades") database.prepare("UPDATE ibkr_flex_sync_batches SET requested_at=? WHERE integration_id=? AND query_id=? AND batch_index=?")
            .run(now.toISOString(), item.integration.id, item.queryId, Number(item.key));
        }
      }
    }
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
  if (!group.length) return false;
  const first = group[0];
  try {
    let xml: string;
    try {
      const references = group.map(item => database.prepare("SELECT reference_code FROM ibkr_flex_poll_jobs WHERE integration_id=? AND kind=? AND query_id=? AND job_key=?")
        .get(...jobArgs(item)) as { reference_code: string | null });
      const referenceCode = references.find(row => row.reference_code)?.reference_code ?? undefined;
      const onReference = (reference: string) => {
        for (const item of group) database.prepare("UPDATE ibkr_flex_poll_jobs SET reference_code=? WHERE integration_id=? AND kind=? AND query_id=? AND job_key=?")
          .run(reference, ...jobArgs(item));
      };
      xml = await (runtime.requestStatement ?? getFlexStatement)(first.token, first.queryId, first.range, undefined, undefined, undefined, { referenceCode, onReference, pollAttempts: 1 });
    } catch (error) {
      if (error instanceof FlexReportPending) {
        for (const item of group) database.prepare("UPDATE ibkr_flex_poll_jobs SET reference_code=?,next_attempt_at=? WHERE integration_id=? AND kind=? AND query_id=? AND job_key=?")
          .run(error.referenceCode, +now + interval, ...jobArgs(item));
        return true;
      }
      const message = (error instanceof Error ? error.message : String(error)).replaceAll(first.token, "[redacted]");
      const code = error instanceof FlexServiceError ? error.code : message.match(/\((10\d\d)\)/)?.[1] ?? null;
      if (code === "1017") for (const item of group) database.prepare("UPDATE ibkr_flex_poll_jobs SET reference_code=NULL WHERE integration_id=? AND kind=? AND query_id=? AND job_key=?")
        .run(...jobArgs(item));
      const previous = database.prepare("SELECT failures FROM ibkr_flex_poll_tokens WHERE token_hash=?").get(first.tokenHash) as { failures: number } | undefined;
      const failures = (previous?.failures ?? 0) + 1;
      const retryAt = +now + retryDelay(code, failures, true);
      database.prepare(`INSERT INTO ibkr_flex_poll_tokens VALUES (?,?,?,?) ON CONFLICT(token_hash) DO UPDATE SET
        next_attempt_at=excluded.next_attempt_at,failures=excluded.failures,last_error=excluded.last_error`)
        .run(first.tokenHash, retryAt, failures, message);
      for (const item of group) failJob(database, item, now, message, code, false, retryAt);
      return true;
    }
    database.prepare("DELETE FROM ibkr_flex_poll_tokens WHERE token_hash=?").run(first.tokenHash);
    for (const item of group) {
      database.prepare("UPDATE ibkr_flex_poll_jobs SET reference_code=NULL WHERE integration_id=? AND kind=? AND query_id=? AND job_key=?")
        .run(...jobArgs(item));
      try {
        if (!/<FlexQueryResponse\b/.test(xml)) throw new Error("IBKR Flex response is not a statement; cached data was preserved.");
        if (item.kind === "funding") cacheIbkrFundingBatch(database, item.integration, item.range, xml, now);
        else if (item.kind === "commissions") cacheFlexCommissions(database, item.integration, item.range, xml, now);
        else writeBatchTrades(database, item.integration, item.queryId, Number(item.key), item.range, parseTrades(xml), now.toISOString());
        database.prepare("UPDATE ibkr_flex_poll_jobs SET synced_at=?,next_attempt_at=?,failures=0,last_error=NULL WHERE integration_id=? AND kind=? AND query_id=? AND job_key=?")
          .run(+now, +now + item.refresh, ...jobArgs(item));
      } catch (error) {
        failJob(database, item, now, (error instanceof Error ? error.message : String(error)).replaceAll(first.token, "[redacted]"), null, true);
      }
    }
    return true;
  } finally {
    database.prepare("UPDATE ibkr_flex_poll_state SET lease_until=0 WHERE id=1").run();
  }
}

let timer: ReturnType<typeof setInterval> | undefined;
export function startFlexSyncLoop(database: Database) {
  if (timer !== undefined) return;
  const run = () => syncNextFlexBatch(database).catch(error => console.error("IBKR Flex poll failed:", error));
  timer = setInterval(run, interval);
  void run();
}
