import type { Integration } from "../../database/integration.ts";
import type { Database } from "../../database/setup.ts";
import { logFetch } from "../../../utils/fetch_logging.ts";
import type { IntegrationOrder } from "../types.ts";
import { parseIbkrCredentials } from "./credentials.ts";

const FLEX_BASE_URL =
  "https://ndcdyn.interactivebrokers.com/AccountManagement/FlexWebService";
const FLEX_BATCH_DAYS = 365;
const DEFAULT_FLEX_MAX_YEARS = 5;

export type FlexTrade = {
  commission?: number | null;
  commissionCurrency?: string | null;
  ticker: string;
  date: Date;
  quantity: number;
  price: number | null;
  currency: string | null;
  assetCategory: string | null;
};

export type FlexStatementRange = {
  from: Date;
  to: Date;
};

type XmlElement = {
  attrs: Record<string, string>;
};

type FlexTradeRow = {
  commission: number | null;
  commission_currency: string | null;
  integration_id: number;
  ticker: string;
  date: string;
  quantity: number;
  price: number | null;
  currency: string | null;
  asset_category: string | null;
};

// Share pacing between trade imports and funding requests using the same token.
// Spacing requests also keeps annual history scans below IBKR's 10/min limit.
const flexRequestQueues = new WeakMap<
  typeof fetch,
  Map<string, { ready: Promise<void>; nextAt: number }>
>();
async function paceFlexRequest<T>(
  request: typeof fetch,
  token: string,
  sleep: (milliseconds: number) => Promise<unknown>,
  clock: () => number,
  perform: () => Promise<T>,
) {
  let tokens = flexRequestQueues.get(request);
  if (!tokens) flexRequestQueues.set(request, tokens = new Map());
  let state = tokens.get(token);
  if (!state) {
    state = { ready: Promise.resolve(), nextAt: 0 };
    tokens.set(token, state);
  }
  const pending = state.ready.then(async () => {
    const delay = state.nextAt - clock();
    if (delay > 0) await sleep(delay);
    state.nextAt = clock() + 6_100;
    return await perform();
  });
  state.ready = pending.then(() => {}, () => {});
  return await pending;
}

export function ensureFlexSchema(database: Database) {
  database.exec("CREATE TABLE IF NOT EXISTS ibkr_flex_commission_queries (integration_id INTEGER NOT NULL,query_id TEXT NOT NULL,supported INTEGER NOT NULL,checked_at REAL NOT NULL,PRIMARY KEY(integration_id,query_id))");
  database.exec(`
    CREATE TABLE IF NOT EXISTS ibkr_flex_trades (
      integration_id INTEGER NOT NULL,
      query_id TEXT NOT NULL,
      trade_key TEXT NOT NULL,
      ticker TEXT NOT NULL,
      date TEXT NOT NULL,
      quantity REAL NOT NULL,
      price REAL,
      currency TEXT,
      asset_category TEXT,
      synced_at TEXT NOT NULL,
      PRIMARY KEY (integration_id, query_id, trade_key)
    );

    CREATE INDEX IF NOT EXISTS ibkr_flex_trades_integration_date_idx
      ON ibkr_flex_trades(integration_id, date);

    CREATE TABLE IF NOT EXISTS ibkr_flex_sync_batches (
      integration_id INTEGER NOT NULL,
      query_id TEXT NOT NULL,
      batch_index INTEGER NOT NULL,
      from_date TEXT NOT NULL,
      to_date TEXT NOT NULL,
      requested_at TEXT,
      synced_at TEXT,
      last_error TEXT,
      PRIMARY KEY (integration_id, query_id, batch_index)
    );
  `);
  const columns = database.prepare("PRAGMA table_info(ibkr_flex_trades)").all() as { name: string }[];
  if (!columns.some(column => column.name === "commission")) {
    database.exec("ALTER TABLE ibkr_flex_trades ADD COLUMN commission REAL");
  }
  if (!columns.some(column => column.name === "commission_currency")) {
    database.exec("ALTER TABLE ibkr_flex_trades ADD COLUMN commission_currency TEXT");
  }
}

export function getFlexMaxYears() {
  const value = Deno.env.get("FLEX_MAX_YEARS");
  if (!value) {
    return DEFAULT_FLEX_MAX_YEARS;
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error("FLEX_MAX_YEARS must be a positive integer");
  }

  return parsed;
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function decodeXmlEntities(value: string) {
  return value
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}

function getXmlText(xml: string, tagName: string) {
  const escapedTagName = escapeRegExp(tagName);
  const match = xml.match(
    new RegExp(`<${escapedTagName}\\b[^>]*>([\\s\\S]*?)</${escapedTagName}>`),
  );
  return match ? decodeXmlEntities(match[1]).trim() : null;
}

function parseXmlAttributes(source: string) {
  const attrs: Record<string, string> = {};
  const attrPattern = /([:\w-]+)\s*=\s*(["'])(.*?)\2/g;
  for (const match of source.matchAll(attrPattern)) {
    attrs[match[1]] = decodeXmlEntities(match[3]);
  }

  return attrs;
}

export function getXmlElements(xml: string, tagNames: string[]) {
  const elements: XmlElement[] = [];
  for (const tagName of tagNames) {
    const escapedTagName = escapeRegExp(tagName);
    const tagPattern = new RegExp(`<${escapedTagName}\\b([^>]*)>`, "g");
    for (const match of xml.matchAll(tagPattern)) {
      elements.push({ attrs: parseXmlAttributes(match[1]) });
    }
  }

  return elements;
}

async function fetchFlexXml(
  request: typeof fetch,
  path: string,
  params: Record<string, string>,
) {
  return logFetch(`IBKR Flex ${path}`, async () => {
    const url = new URL(`${FLEX_BASE_URL}${path}`);
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, value);
    }

    const response = await request(url, {
      headers: { "User-Agent": "eyri" },
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) {
      throw new Error(`IBKR Flex request failed: ${response.status}`);
    }

    return await response.text();
  });
}

function formatFlexDate(date: Date) {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${year}${month}${day}`;
}

function formatDateKey(date: Date) {
  return date.toISOString().slice(0, 10);
}

function addDays(date: Date, days: number) {
  const next = new Date(date);
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

function getTodayUtc(now: Date) {
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
}

export function getFlexStatementRange(
  batchIndex: number,
  now = new Date(),
): FlexStatementRange {
  // Flex fails with 1003 when td is in the future and omits same-day trades,
  // so batches end yesterday UTC; the Gateway execution sync covers today.
  const end = addDays(getTodayUtc(now), -1 - batchIndex * FLEX_BATCH_DAYS);
  const from = addDays(end, -(FLEX_BATCH_DAYS - 1));
  return { from, to: end };
}

export class FlexServiceError extends Error {
  constructor(message: string, readonly code: string | null) {
    super(message);
    this.name = "FlexServiceError";
  }
}

export class FlexReportPending extends FlexServiceError {
  constructor(readonly referenceCode: string) {
    super("IBKR Flex statement is still being generated; polling will resume in the background.", "1019");
    this.name = "FlexReportPending";
  }
}

export async function getFlexStatement(
  token: string,
  queryId: string,
  range: FlexStatementRange,
  request: typeof fetch = fetch,
  sleep = (milliseconds: number) =>
    new Promise((resolve) => setTimeout(resolve, milliseconds)),
  clock = Date.now,
  progress: { referenceCode?: string; onReference?: (reference: string) => void; pollAttempts?: number } = {},
) {
  let referenceCode = progress.referenceCode;
  if (!referenceCode) {
    const sendXml = await paceFlexRequest(
      request,
      token,
      sleep,
      clock,
      () =>
        fetchFlexXml(request, "/SendRequest", {
          t: token,
          q: queryId,
          fd: formatFlexDate(range.from),
          td: formatFlexDate(range.to),
          v: "3",
        }),
    );
    const status = getXmlText(sendXml, "Status");
    if (status !== "Success") {
      const code = getXmlText(sendXml, "ErrorCode");
      const message = getXmlText(sendXml, "ErrorMessage");
      throw new FlexServiceError(
        `IBKR Flex report generation failed${code ? ` (${code})` : ""}: ${
          message ?? "unknown error"
        }`,
        code,
      );
    }

    referenceCode = getXmlText(sendXml, "ReferenceCode") ?? undefined;
    if (!referenceCode) {
      throw new Error("IBKR Flex response did not include a reference code");
    }
    progress.onReference?.(referenceCode);
  }

  for (let attempt = 0; attempt < (progress.pollAttempts ?? 5); attempt++) {
    if (attempt > 0) {
      await sleep(3_000);
    }

    const statementXml = await paceFlexRequest(
      request,
      token,
      sleep,
      clock,
      () =>
        fetchFlexXml(request, "/GetStatement", {
          t: token,
          q: referenceCode!,
          v: "3",
        }),
    );
    const statementStatus = getXmlText(statementXml, "Status");
    if (!statementStatus || statementStatus === "Success") {
      return statementXml;
    }

    const code = getXmlText(statementXml, "ErrorCode");
    if (code !== "1003" && code !== "1004" && code !== "1019") {
      const message = getXmlText(statementXml, "ErrorMessage");
      throw new FlexServiceError(
        `IBKR Flex statement retrieval failed (${code}): ${
          message ?? "unknown error"
        }`,
        code,
      );
    }
  }

  throw new FlexReportPending(referenceCode);
}

function getAttr(element: XmlElement, names: string[]) {
  for (const name of names) {
    const value = element.attrs[name];
    if (value) {
      return value;
    }
  }

  return null;
}

export function parseDate(value: string | null) {
  if (!value) {
    return null;
  }

  const datePart = value.match(/\d{4}-?\d{2}-?\d{2}/)?.[0];
  if (!datePart) {
    return null;
  }

  const normalized = datePart.replaceAll("-", "");
  const year = Number(normalized.slice(0, 4));
  const month = Number(normalized.slice(4, 6));
  const day = Number(normalized.slice(6, 8));
  if ([year, month, day].some(Number.isNaN)) {
    return null;
  }

  return new Date(Date.UTC(year, month - 1, day));
}

function getSignedQuantity(
  quantityValue: string | null,
  sideValue: string | null,
) {
  const quantity = Number(quantityValue);
  if (Number.isNaN(quantity) || quantity === 0) {
    return null;
  }

  const side = sideValue?.toUpperCase();
  if (side === "SELL" || side === "SLD" || side === "S") {
    return -Math.abs(quantity);
  }
  if (side === "BUY" || side === "BOT" || side === "B") {
    return Math.abs(quantity);
  }

  return quantity;
}

function parseQuantity(element: XmlElement) {
  const quantity = Number(
    getAttr(element, ["quantity", "qty", "shares", "Quantity", "Shares"]),
  );
  if (Number.isNaN(quantity) || quantity === 0) {
    return null;
  }

  const side = getAttr(element, [
    "buySell",
    "side",
    "Side",
    "transactionType",
    "TransactionType",
  ]);
  return getSignedQuantity(String(quantity), side);
}

function parsePrice(element: XmlElement) {
  const value = Number(
    getAttr(element, ["tradePrice", "TradePrice", "price", "Price"]),
  );
  return Number.isNaN(value) ? null : value;
}

export function parseTrades(xml: string) {
  const trades: FlexTrade[] = [];
  for (const element of getXmlElements(xml, ["Trade", "TradeConfirm"])) {
    const ticker = getAttr(element, [
      "symbol",
      "Symbol",
      "underlyingSymbol",
      "UnderlyingSymbol",
    ]);
    const date = parseDate(
      getAttr(element, [
        "tradeDate",
        "TradeDate",
        "dateTime",
        "DateTime",
        "transactionDate",
        "TransactionDate",
      ]),
    );
    const quantity = parseQuantity(element);

    if (!ticker || !date || quantity === null) {
      continue;
    }

    trades.push({
      ticker,
      date,
      quantity,
      price: parsePrice(element),
      commission: getAttr(element, ["commission", "ibCommission"])?.trim() && Number.isFinite(Number(getAttr(element, ["commission", "ibCommission"])))
        ? Number(getAttr(element, ["commission", "ibCommission"])) : null,
      commissionCurrency: getAttr(element, ["commissionCurrency", "ibCommissionCurrency", "currency"]),
      currency: getAttr(element, ["currency", "Currency"]),
      assetCategory: getAttr(element, [
        "assetCategory",
        "AssetCategory",
        "ibAssetCategory",
        "IBAssetCategory",
      ]),
    });
  }

  return trades;
}

function getTradeKey(trade: FlexTrade, index: number) {
  return [
    formatDateKey(trade.date),
    trade.ticker,
    trade.quantity,
    trade.price ?? "",
    trade.currency ?? "",
    trade.assetCategory ?? "",
    index,
  ].join(":");
}

export function writeBatchTrades(
  database: Database,
  integration: Integration,
  queryId: string,
  batchIndex: number,
  range: FlexStatementRange,
  trades: FlexTrade[],
  syncedAt = new Date().toISOString(),
) {
  ensureFlexSchema(database);

  database.exec("BEGIN");
  try {
    database
      .prepare(`
        DELETE FROM ibkr_flex_trades
        WHERE integration_id = ?
          AND query_id = ?
          AND date >= ?
          AND date <= ?
      `)
      .run(
        integration.id,
        queryId,
        formatDateKey(range.from),
        formatDateKey(range.to),
      );

    const insertTrade = database.prepare(`
      INSERT INTO ibkr_flex_trades (
        integration_id,
        query_id,
        trade_key,
        ticker,
        date,
        quantity,
        price,
        currency,
        asset_category,
        commission,
        commission_currency,
        synced_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    trades.forEach((trade, index) => {
      insertTrade.run(
        integration.id,
        queryId,
        getTradeKey(trade, index),
        trade.ticker,
        formatDateKey(trade.date),
        trade.quantity,
        trade.price,
        trade.currency,
        trade.assetCategory,
        trade.commission ?? null,
        trade.commissionCurrency ?? trade.currency,
        syncedAt,
      );
    });

    database
      .prepare(`
        UPDATE ibkr_flex_sync_batches
        SET synced_at = ?,
          last_error = NULL
        WHERE integration_id = ?
          AND query_id = ?
          AND batch_index = ?
      `)
      .run(syncedAt, integration.id, queryId, batchIndex);

    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

export function readFlexOrders(
  database: Database,
  integration: Integration,
): IntegrationOrder[] {
  ensureFlexSchema(database);
  const credentials = parseIbkrCredentials(integration.credentials);
  if (!credentials.flexQueryId) {
    return [];
  }

  const rows = database
    .prepare(`
      SELECT
        integration_id,
        ticker,
        date,
        quantity,
        price,
        currency,
        asset_category,
        commission,
        commission_currency
      FROM ibkr_flex_trades
      WHERE integration_id = ?
        AND query_id = ?
      ORDER BY date
    `)
    .all(integration.id, credentials.flexQueryId) as FlexTradeRow[];

  return rows.map((row) => ({
    integrationId: row.integration_id,
    integrationKind: integration.kind,
    account: "",
    ticker: row.ticker,
    date: new Date(row.date),
    quantity: row.quantity,
    price: row.price,
    currency: row.currency ?? "USD",
    assetCategory: row.asset_category,
    ...(row.commission === null ? {} : { commission: { amount: row.commission, currency: row.commission_currency ?? row.currency ?? "USD" } }),
  }));
}

// The background poller backfills one annual range at a time. Report readers
// never request Flex data, including when old executions lack commissions.
export function getFlexCommissionRange(
  database: Database, integration: Integration, now = new Date(),
): FlexStatementRange | undefined {
  ensureFlexSchema(database);
  const credentials = parseIbkrCredentials(integration.credentials);
  if (!credentials.flexToken || !credentials.flexQueryId) return;
  const support = database.prepare("SELECT supported,checked_at FROM ibkr_flex_commission_queries WHERE integration_id=? AND query_id=?")
    .get(integration.id, credentials.flexQueryId) as { supported: number; checked_at: number } | undefined;
  if (support?.supported === 0 && +now - support.checked_at < 3_600_000) return;
  const missing = database.prepare("SELECT MIN(date) AS first,MAX(date) AS last FROM ibkr_flex_trades WHERE integration_id=? AND query_id=? AND commission IS NULL")
    .get(integration.id, credentials.flexQueryId) as { first: string | null; last: string | null };
  if (!missing.first || !missing.last) return;
  const from = new Date(missing.first);
  return { from, to: new Date(Math.min(+new Date(missing.last), +from + 364 * 86_400_000)) };
}

export function cacheFlexCommissions(
  database: Database, integration: Integration, range: FlexStatementRange,
  xml: string, now = new Date(),
) {
  ensureFlexSchema(database);
  const credentials = parseIbkrCredentials(integration.credentials);
  const queryId = credentials.flexQueryId!;
  const trades = parseTrades(xml);
  if (!trades.length) throw new Error("IBKR commission backfill returned no executions for existing history; cached trades were preserved.");
  if (trades.some(trade => trade.commission === null)) {
    database.prepare("INSERT OR REPLACE INTO ibkr_flex_commission_queries VALUES (?,?,0,?)").run(integration.id, queryId, +now);
    return;
  }
  writeBatchTrades(database, integration, queryId, -1, range, trades, now.toISOString());
  database.prepare("INSERT OR REPLACE INTO ibkr_flex_commission_queries VALUES (?,?,1,?)").run(integration.id, queryId, +now);
}
