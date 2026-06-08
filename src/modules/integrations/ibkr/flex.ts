import {
  getAllIntegrations,
  type Integration,
} from "../../database/integration.ts";
import type { Database } from "../../database/setup.ts";
import type { IntegrationOrder } from "../types.ts";
import { type IbkrCredentials, parseIbkrCredentials } from "./credentials.ts";

const FLEX_BASE_URL =
  "https://ndcdyn.interactivebrokers.com/AccountManagement/FlexWebService";
const FLEX_SYNC_INTERVAL_MS = 10 * 1000;
const FLEX_BATCH_DAYS = 365;
const DEFAULT_FLEX_MAX_YEARS = 5;

export type FlexTrade = {
  ticker: string;
  date: Date;
  quantity: number;
  price: number | null;
  currency: string | null;
  assetCategory: string | null;
};

type FlexStatementRange = {
  from: Date;
  to: Date;
};

type XmlElement = {
  attrs: Record<string, string>;
};

type FlexTradeRow = {
  integration_id: number;
  ticker: string;
  date: string;
  quantity: number;
  price: number | null;
  currency: string | null;
  asset_category: string | null;
};

type FlexSyncBatchRow = {
  batch_index: number;
  requested_at: string | null;
  synced_at: string | null;
};

type FlexBatchCandidate = {
  integration: Integration;
  credentials: IbkrCredentials;
  batchIndex: number;
  range: FlexStatementRange;
  requestedAt: string | null;
  syncedAt: string | null;
};

let isFlexSyncRunning = false;
let flexSyncTimer: number | null = null;

function ensureFlexSchema(database: Database) {
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
}

function getFlexMaxYears() {
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

function getXmlElements(xml: string, tagNames: string[]) {
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

async function fetchFlexXml(path: string, params: Record<string, string>) {
  const url = new URL(`${FLEX_BASE_URL}${path}`);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }

  const response = await fetch(url, {
    headers: { "User-Agent": "eyri" },
  });
  if (!response.ok) {
    throw new Error(`IBKR Flex request failed: ${response.status}`);
  }

  return await response.text();
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

function getTodayUtc() {
  const today = new Date();
  return new Date(
    Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()),
  );
}

function getFlexStatementRange(batchIndex: number): FlexStatementRange {
  const end = addDays(getTodayUtc(), -batchIndex * FLEX_BATCH_DAYS);
  const from = addDays(end, -(FLEX_BATCH_DAYS - 1));
  return { from, to: end };
}

async function getFlexStatement(
  token: string,
  queryId: string,
  range: FlexStatementRange,
) {
  const sendXml = await fetchFlexXml("/SendRequest", {
    t: token,
    q: queryId,
    fd: formatFlexDate(range.from),
    td: formatFlexDate(range.to),
    v: "3",
  });
  const status = getXmlText(sendXml, "Status");
  if (status !== "Success") {
    const code = getXmlText(sendXml, "ErrorCode");
    const message = getXmlText(sendXml, "ErrorMessage");
    throw new Error(
      `IBKR Flex report generation failed${code ? ` (${code})` : ""}: ${
        message ?? "unknown error"
      }`,
    );
  }

  const referenceCode = getXmlText(sendXml, "ReferenceCode");
  if (!referenceCode) {
    throw new Error("IBKR Flex response did not include a reference code");
  }

  for (let attempt = 0; attempt < 5; attempt++) {
    if (attempt > 0) {
      await new Promise((resolve) => setTimeout(resolve, 3_000));
    }

    const statementXml = await fetchFlexXml("/GetStatement", {
      t: token,
      q: referenceCode,
      v: "3",
    });
    const statementStatus = getXmlText(statementXml, "Status");
    if (!statementStatus || statementStatus === "Success") {
      return statementXml;
    }

    const code = getXmlText(statementXml, "ErrorCode");
    if (code === "1019") {
      const message = getXmlText(statementXml, "ErrorMessage");
      throw new Error(
        `IBKR Flex statement retrieval rate-limited (1019): ${
          message ?? "too many requests"
        }`,
      );
    }

    if (code !== "1003" && code !== "1004") {
      const message = getXmlText(statementXml, "ErrorMessage");
      throw new Error(
        `IBKR Flex statement retrieval failed (${code}): ${
          message ?? "unknown error"
        }`,
      );
    }
  }

  throw new Error("IBKR Flex statement was not ready in time");
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

function parseDate(value: string | null) {
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

function parseTrades(xml: string) {
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

function upsertFlexBatch(
  database: Database,
  integration: Integration,
  queryId: string,
  batchIndex: number,
  range: FlexStatementRange,
) {
  ensureFlexSchema(database);
  database
    .prepare(`
      INSERT INTO ibkr_flex_sync_batches (
        integration_id,
        query_id,
        batch_index,
        from_date,
        to_date
      ) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(integration_id, query_id, batch_index) DO UPDATE SET
        from_date = excluded.from_date,
        to_date = excluded.to_date
    `)
    .run(
      integration.id,
      queryId,
      batchIndex,
      formatDateKey(range.from),
      formatDateKey(range.to),
    );
}

function getBatchRow(
  database: Database,
  integration: Integration,
  queryId: string,
  batchIndex: number,
) {
  ensureFlexSchema(database);
  return database
    .prepare(`
      SELECT batch_index, requested_at, synced_at
      FROM ibkr_flex_sync_batches
      WHERE integration_id = ?
        AND query_id = ?
        AND batch_index = ?
    `)
    .get(integration.id, queryId, batchIndex) as
      | FlexSyncBatchRow
      | undefined;
}

function getBatchLastRequestMs(candidate: FlexBatchCandidate) {
  const lastRequest = candidate.requestedAt ?? candidate.syncedAt;
  if (!lastRequest) {
    return null;
  }

  const lastRequestMs = new Date(lastRequest).getTime();
  return Number.isNaN(lastRequestMs) ? null : lastRequestMs;
}

function getNextFlexBatch(
  database: Database,
): {
  integration: Integration;
  credentials: IbkrCredentials;
  batchIndex: number;
  range: FlexStatementRange;
} | null {
  const maxYears = getFlexMaxYears();
  const integrations = getAllIntegrations(database);
  const candidates: FlexBatchCandidate[] = [];

  for (const integration of integrations) {
    if (integration.kind !== "ibkr") {
      continue;
    }

    const credentials = parseIbkrCredentials(integration.credentials);
    if (!credentials.flexToken || !credentials.flexQueryId) {
      continue;
    }

    for (let batchIndex = 0; batchIndex < maxYears; batchIndex++) {
      const range = getFlexStatementRange(batchIndex);
      upsertFlexBatch(
        database,
        integration,
        credentials.flexQueryId,
        batchIndex,
        range,
      );
      const row = getBatchRow(
        database,
        integration,
        credentials.flexQueryId,
        batchIndex,
      );
      candidates.push({
        integration,
        credentials,
        batchIndex,
        range,
        requestedAt: row?.requested_at ?? null,
        syncedAt: row?.synced_at ?? null,
      });
    }
  }

  const neverRequested = candidates.find((candidate) =>
    !candidate.requestedAt && !candidate.syncedAt
  );
  if (neverRequested) {
    return neverRequested;
  }

  return candidates
    .map((candidate) => ({
      candidate,
      lastRequestMs: getBatchLastRequestMs(candidate),
    }))
    .filter(({ lastRequestMs }) =>
      lastRequestMs === null ||
      Date.now() - lastRequestMs >= FLEX_SYNC_INTERVAL_MS
    )
    .sort((a, b) => (a.lastRequestMs ?? 0) - (b.lastRequestMs ?? 0))
    .at(0)?.candidate ?? null;
}

function markBatchRequested(
  database: Database,
  integration: Integration,
  queryId: string,
  batchIndex: number,
) {
  ensureFlexSchema(database);
  database
    .prepare(`
      UPDATE ibkr_flex_sync_batches
      SET requested_at = ?,
        last_error = NULL
      WHERE integration_id = ?
        AND query_id = ?
        AND batch_index = ?
    `)
    .run(new Date().toISOString(), integration.id, queryId, batchIndex);
}

function markBatchFailed(
  database: Database,
  integration: Integration,
  queryId: string,
  batchIndex: number,
  error: unknown,
) {
  ensureFlexSchema(database);
  const message = error instanceof Error ? error.message : String(error);
  database
    .prepare(`
      UPDATE ibkr_flex_sync_batches
      SET last_error = ?
      WHERE integration_id = ?
        AND query_id = ?
        AND batch_index = ?
    `)
    .run(message, integration.id, queryId, batchIndex);
}

function writeBatchTrades(
  database: Database,
  integration: Integration,
  queryId: string,
  batchIndex: number,
  range: FlexStatementRange,
  trades: FlexTrade[],
) {
  ensureFlexSchema(database);
  const syncedAt = new Date().toISOString();

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
        synced_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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

async function syncFlexBatch(
  database: Database,
  integration: Integration,
  credentials: IbkrCredentials,
  batchIndex: number,
  range: FlexStatementRange,
) {
  if (!credentials.flexToken || !credentials.flexQueryId) {
    return;
  }

  markBatchRequested(
    database,
    integration,
    credentials.flexQueryId,
    batchIndex,
  );
  try {
    const statement = await getFlexStatement(
      credentials.flexToken,
      credentials.flexQueryId,
      range,
    );
    const trades = parseTrades(statement);
    writeBatchTrades(
      database,
      integration,
      credentials.flexQueryId,
      batchIndex,
      range,
      trades,
    );
    console.info(
      `Synced IBKR Flex integration=${integration.id} batch=${batchIndex} trades=${trades.length}`,
    );
  } catch (error) {
    markBatchFailed(
      database,
      integration,
      credentials.flexQueryId,
      batchIndex,
      error,
    );
    console.error(
      `Failed to sync IBKR Flex integration=${integration.id} batch=${batchIndex}:`,
      error,
    );
  }
}

export async function syncNextFlexBatch(database: Database) {
  const nextBatch = getNextFlexBatch(database);
  if (!nextBatch) {
    return false;
  }

  await syncFlexBatch(
    database,
    nextBatch.integration,
    nextBatch.credentials,
    nextBatch.batchIndex,
    nextBatch.range,
  );
  return true;
}

export function startFlexSyncLoop(database: Database) {
  ensureFlexSchema(database);
  if (flexSyncTimer !== null) {
    return;
  }

  const run = async () => {
    if (isFlexSyncRunning) {
      return;
    }

    isFlexSyncRunning = true;
    try {
      await syncNextFlexBatch(database);
    } finally {
      isFlexSyncRunning = false;
    }
  };

  flexSyncTimer = setInterval(run, FLEX_SYNC_INTERVAL_MS);
  run();
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
        asset_category
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
  }));
}
