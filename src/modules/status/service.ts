import { createHash } from "node:crypto";
import { getAllIntegrations, type Integration } from "../database/integration.ts";
import type { Database } from "../database/setup.ts";
import { probeIntegration } from "../integrations/service.ts";
import { getIbkrHostPort, parseIbkrCredentials } from "../integrations/ibkr/credentials.ts";
import { gatewayMonitor, type GatewayHealth } from "../integrations/ibkr/gateway.ts";
import { getIbkrFundingSyncRanges } from "../integrations/ibkr/ledger.ts";

export type Check = {
  name: string;
  state: "ok" | "error" | "pending" | "paused" | "unknown";
  message?: string;
  lastSuccess?: number;
  nextAttempt?: number;
};
export type ConnectorStatus = {
  integrationId: number;
  ownerId: number;
  kind: Integration["kind"];
  endpoint?: string;
  state: "healthy" | "degraded" | "offline" | "blocked" | "recovering";
  checks: Check[];
};
export type StatusReport = { checkedAt: number; connectors: ConnectorStatus[] };
type Runtime = {
  probe: (integration: Integration) => Promise<void>;
  gateway: (host: string) => Promise<GatewayHealth>;
  now: () => number;
  timeoutMs: number;
};

function hasTable(database: Database, table: string) {
  return Boolean(database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table));
}

// Broker failures can contain echoed HTTP bodies or credentials. Redact every
// configured connector's secrets before putting any diagnostic in Telegram.
function redactFor(integrations: Integration[]) {
  const secrets = new Set<string>();
  for (const { credentials } of integrations) {
    for (const [name, value] of Object.entries(credentials)) {
      if (typeof value !== "string" || !value || !/key|secret|token|password|authorization|twofactor/i.test(name)) continue;
      for (const secret of [value, value.trim()]) if (secret) {
        secrets.add(secret);
        secrets.add(encodeURIComponent(secret));
      }
    }
    if (typeof credentials.apiKey === "string" && typeof credentials.secretKey === "string") {
      try { secrets.add(btoa(`${credentials.apiKey.trim()}:${credentials.secretKey.trim()}`)); }
      catch { /* Invalid credentials are reported by the probe, not this redactor. */ }
    }
  }
  const values = [...secrets].sort((a, b) => b.length - a.length);
  return (value: unknown) => {
    let message = value instanceof Error ? value.message : String(value);
    for (const secret of values) message = message.replaceAll(secret, "[redacted]");
    return message.length > 450 ? `${message.slice(0, 449)}…` : message;
  };
}

async function bounded<T>(action: () => Promise<T>, timeoutMs: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(action),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`Status check timed out after ${Math.ceil(timeoutMs / 1_000)}s`)), timeoutMs);
      }),
    ]);
  } finally { clearTimeout(timer); }
}

type Job = { kind: string; job_key: string; synced_at: number | null; next_attempt_at: number; last_error: string | null; reference_code: string | null };
function ibkrSyncChecks(database: Database, integration: Integration, now: number, redact: (value: unknown) => string): Check[] {
  const credentials = parseIbkrCredentials(integration.credentials);
  if (!credentials.flexToken || !credentials.flexQueryId) {
    return [{ name: "Flex", state: "unknown", message: "Token or trade query is not configured" }];
  }
  const fundingQuery = credentials.fundingFlexQueryId ?? credentials.flexQueryId;
  const jobs = hasTable(database, "ibkr_flex_poll_jobs")
    ? database.prepare(`SELECT kind,job_key,CAST(synced_at AS REAL) AS synced_at,CAST(next_attempt_at AS REAL) AS next_attempt_at,last_error,reference_code
        FROM ibkr_flex_poll_jobs WHERE integration_id=? AND ((kind='funding' AND query_id=?) OR (kind<>'funding' AND query_id=?))`)
      .all(integration.id, fundingQuery, credentials.flexQueryId) as Job[]
    : [];
  const checks: Check[] = [];
  const fundingKeys = hasTable(database, "ibkr_funding_batches")
    ? new Set(getIbkrFundingSyncRanges(database, integration, new Date(now)).map(range => `${range.from.toISOString().slice(0, 10)}:${range.to.toISOString().slice(0, 10)}`))
    : undefined;
  const missingFees = hasTable(database, "ibkr_flex_trades") ? database.prepare(
    "SELECT COUNT(*) AS count,MIN(date) AS first,MAX(date) AS last FROM ibkr_flex_trades WHERE integration_id=? AND query_id=? AND commission IS NULL",
  ).get(integration.id, credentials.flexQueryId) as { count: number; first: string | null; last: string | null } : undefined;
  const feesKey = missingFees?.first && missingFees.last
    ? `${missingFees.first}:${new Date(Math.min(+new Date(missingFees.last), +new Date(missingFees.first) + 364 * 86_400_000)).toISOString().slice(0, 10)}` : undefined;
  let tokenRetryAt = 0;
  if (hasTable(database, "ibkr_flex_poll_tokens")) {
    const hash = createHash("sha256").update(credentials.flexToken).digest("hex");
    const pause = database.prepare("SELECT CAST(next_attempt_at AS REAL) AS next_attempt_at,last_error FROM ibkr_flex_poll_tokens WHERE token_hash=?").get(hash) as {
      next_attempt_at: number; last_error: string | null;
    } | undefined;
    if (pause && pause.next_attempt_at > now) {
      tokenRetryAt = pause.next_attempt_at;
      checks.push({ name: "Flex token", state: "paused", nextAttempt: pause.next_attempt_at,
        message: pause.last_error ? redact(pause.last_error) : "Polling is backing off" });
    }
  }
  for (const [kind, name] of [["trades", "Flex trades"], ["funding", "Flex funding"], ["commissions", "Flex commissions"]]) {
    const selected = jobs.filter(job => job.kind === kind &&
      (kind !== "funding" || !fundingKeys || fundingKeys.has(job.job_key)) &&
      (kind !== "commissions" || !missingFees || job.job_key === feesKey));
    if (!selected.length && kind === "commissions") {
      if (missingFees?.count) {
        const support = hasTable(database, "ibkr_flex_commission_queries") ? database.prepare(
          "SELECT supported FROM ibkr_flex_commission_queries WHERE integration_id=? AND query_id=?",
        ).get(integration.id, credentials.flexQueryId) as { supported: number } | undefined : undefined;
        checks.push({ name, state: support?.supported === 0 ? "error" : "pending",
          message: `${missingFees.count} cached executions have unknown fees; ${support?.supported === 0 ? "include commission fields in the Flex trade query" : "awaiting background backfill"}` });
      }
      continue;
    }
    const successes = selected.flatMap(job => job.synced_at === null ? [] : [job.synced_at]);
    const failure = selected.find(job => job.last_error);
    const pending = selected.some(job => job.reference_code || job.synced_at === null);
    const check: Check = { name, state: failure ? "error" : pending || !selected.length ? "pending" : "ok",
      ...(successes.length ? { lastSuccess: Math.max(...successes) } : {}),
      message: failure ? redact(failure.last_error) : selected.length ? `${successes.length}/${selected.length} batches cached${pending ? "; sync in progress" : ""}` : "Awaiting background sync",
      ...((failure || pending) && selected.length ? { nextAttempt: Math.max(tokenRetryAt, Math.min(...selected.map(job => job.next_attempt_at))) || undefined } : {}),
    };
    if (kind === "funding" && hasTable(database, "ibkr_funding_batches")) {
      const cached = database.prepare("SELECT MAX(to_date) AS through,MAX(CAST(fetched_at AS REAL)) AS fetched FROM ibkr_funding_batches WHERE integration_id=? AND query_id=?")
        .get(integration.id, fundingQuery) as { through: string | null; fetched: number | null };
      if (cached.through) {
        check.message = `${check.message}; statement through ${cached.through.slice(0, 10)}`;
        check.lastSuccess ??= cached.fetched ?? undefined;
      }
    }
    // Show deployments with legacy trade sync metadata as well as the new poller.
    if (kind === "trades" && !selected.length && hasTable(database, "ibkr_flex_sync_batches")) {
      const legacy = database.prepare("SELECT MAX(synced_at) AS synced FROM ibkr_flex_sync_batches WHERE integration_id=? AND query_id=?")
        .get(integration.id, credentials.flexQueryId) as { synced: string | null };
      const error = database.prepare("SELECT last_error FROM ibkr_flex_sync_batches WHERE integration_id=? AND query_id=? AND last_error IS NOT NULL ORDER BY requested_at DESC LIMIT 1")
        .get(integration.id, credentials.flexQueryId) as { last_error: string } | undefined;
      if (legacy.synced) { check.lastSuccess = +new Date(legacy.synced); check.state = "ok"; check.message = "Legacy trade cache available"; }
      if (error) { check.state = "error"; check.message = redact(error.last_error); }
    }
    checks.push(check);
  }
  if (hasTable(database, "ibkr_executions")) {
    const row = database.prepare("SELECT MAX(synced_at) AS synced FROM ibkr_executions WHERE integration_id=?").get(integration.id) as { synced: string | null };
    checks.push({ name: "Execution cache", state: "unknown", message: row.synced ? "Last execution received" : "No cached executions (the account may have no recent trades)",
      ...(row.synced ? { lastSuccess: +new Date(row.synced) } : {}) });
  }
  return checks;
}

function trading212SyncChecks(database: Database, integration: Integration): Check[] {
  const checks: Check[] = [];
  for (const [table, name] of [["trading212_history_sync", "Order history"], ["trading212_transaction_sync", "Cash history"]]) {
    const row = hasTable(database, table) ? database.prepare(`SELECT CAST(synced_at AS REAL) AS synced FROM ${table} WHERE integration_id=?`).get(integration.id) as { synced: number } | undefined : undefined;
    checks.push({ name, state: row ? "ok" : "unknown", ...(row ? { lastSuccess: row.synced } : { message: "Not cached yet" }) });
  }
  if (hasTable(database, "trading212_ledger_exports")) {
    const row = database.prepare("SELECT MAX(time_to) AS through,MAX(CAST(fetched_at AS REAL)) AS fetched FROM trading212_ledger_exports WHERE integration_id=?").get(integration.id) as {
      through: string | null; fetched: number | null;
    };
    const pending = hasTable(database, "trading212_ledger_requests")
      ? database.prepare("SELECT COUNT(*) AS count FROM trading212_ledger_requests WHERE integration_id=?").get(integration.id)!.count as number : 0;
    checks.push({ name: "Cash ledger exports", state: pending ? "pending" : row.through ? "ok" : "unknown",
      message: `${row.through ? `Cached through ${row.through.slice(0, 10)}` : "Not cached yet"}${pending ? `; ${pending} export(s) pending` : ""}`,
      ...(row.fetched ? { lastSuccess: row.fetched } : {}) });
  }
  return checks;
}

export async function collectConnectorStatus(database: Database, overrides: Partial<Runtime> = {}): Promise<StatusReport> {
  const runtime: Runtime = { probe: probeIntegration, gateway: host => gatewayMonitor.read(host, true), now: Date.now, timeoutMs: 15_000, ...overrides };
  const checkedAt = runtime.now();
  const integrations = getAllIntegrations(database);
  const redact = redactFor(integrations);
  const healthRequests = new Map<string, Promise<GatewayHealth>>();
  const connectors = await Promise.all(integrations.map(async integration => {
    const status: ConnectorStatus = { integrationId: integration.id, ownerId: integration.userId, kind: integration.kind, state: "healthy", checks: [] };
    let canProbe = true;
    if (integration.kind === "ibkr") {
      try {
        const { host, port } = getIbkrHostPort(parseIbkrCredentials(integration.credentials).instanceUrl);
        status.endpoint = `${host}:${port}`;
        let request = healthRequests.get(host);
        if (!request) { request = bounded(() => runtime.gateway(host), runtime.timeoutMs); healthRequests.set(host, request); }
        const health = await request;
        status.checks.push({ name: "Gateway login", state: health.state === "ready" ? "ok" : health.state === "unknown" ? "unknown" : "error", message: redact(health.message) });
        if (health.state !== "ready" && health.state !== "unknown") {
          canProbe = false;
          status.state = health.state === "blocked" ? "blocked" : health.state === "recovering" ? "recovering" : "offline";
        }
      } catch (error) {
        canProbe = false; status.state = "offline";
        status.checks.push({ name: "Gateway login", state: "error", message: redact(error) });
      }
    }
    if (canProbe) {
      try {
        await bounded(() => runtime.probe(integration), runtime.timeoutMs);
        status.checks.push({ name: "Live API", state: "ok", lastSuccess: runtime.now() });
      } catch (error) {
        status.state = "offline";
        status.checks.push({ name: "Live API", state: "error", message: redact(error) });
      }
    } else status.checks.push({ name: "Live API", state: "unknown", message: "Unavailable until Gateway login is ready" });
    try {
      if (integration.kind === "ibkr") status.checks.push(...ibkrSyncChecks(database, integration, checkedAt, redact));
      if (integration.kind === "t212") status.checks.push(...trading212SyncChecks(database, integration));
    } catch (error) { status.checks.push({ name: "Sync metadata", state: "error", message: redact(error) }); }
    if (status.state === "healthy" && status.checks.some(check => ["error", "paused", "pending"].includes(check.state) || check.name === "Flex")) status.state = "degraded";
    return status;
  }));
  return { checkedAt, connectors };
}
