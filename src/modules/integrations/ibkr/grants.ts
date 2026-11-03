import { createHash } from "node:crypto";
import type { Integration } from "../../database/integration.ts";
import type { Database } from "../../database/setup.ts";
import type { IntegrationOrder } from "../types.ts";
import { parseIbkrCredentials } from "./credentials.ts";
import { type FlexStatementRange, getXmlElements, parseDate } from "./flex.ts";

function ensureSchema(database: Database) {
  database.exec(`CREATE TABLE IF NOT EXISTS ibkr_stock_grants (
    integration_id INTEGER NOT NULL, query_id TEXT NOT NULL, grant_key TEXT NOT NULL,
    report_date TEXT NOT NULL, payload TEXT NOT NULL,
    PRIMARY KEY(integration_id,query_id,grant_key))`);
}

// Keep dated share receipts separate from cash funding and executed trades.
export function cacheIbkrStockGrants(
  database: Database,
  integration: Integration,
  queryId: string,
  range: FlexStatementRange,
  xml: string,
) {
  const credentials = parseIbkrCredentials(integration.credentials);
  const statements = [
    ...xml.matchAll(/<FlexStatement\b([^>]*)>([\s\S]*?)<\/FlexStatement>/g),
  ]
    .filter((match) =>
      !credentials.accountId ||
      getXmlElements(`<FlexStatement ${match[1]}>`, ["FlexStatement"])[0]?.attrs
          .accountId === credentials.accountId
    );
  if (
    statements.length !== 1 || !/<StockGrantActivities\b/.test(statements[0][2])
  ) return;
  const header =
    getXmlElements(`<FlexStatement ${statements[0][1]}>`, ["FlexStatement"])[0]
      .attrs;
  const from = range.from.toISOString().slice(0, 10),
    to = range.to.toISOString().slice(0, 10);
  const occurrences = new Map<string, number>();
  const grants = getXmlElements(statements[0][2], ["StockGrantActivity"]).map(
    ({ attrs }) => {
      const date = parseDate(attrs.reportDate ?? null);
      const reportedDay = attrs.reportDate?.match(/^(\d{8}|\d{4}-\d{2}-\d{2})/)
        ?.[1].replaceAll("-", "");
      const quantity = Number(attrs.quantity);
      if (
        !header.accountId ||
        attrs.accountId && attrs.accountId !== header.accountId ||
        !date || !Number.isFinite(+date) ||
        date.toISOString().slice(0, 10).replaceAll("-", "") !== reportedDay ||
        !attrs.quantity?.trim() || !Number.isFinite(quantity) ||
        !attrs.symbol?.trim() || !/^[A-Z]{3}$/.test(attrs.currency ?? "") ||
        attrs.assetCategory && attrs.assetCategory !== "STK"
      ) {
        throw new Error(
          "IBKR Grant Activity needs Account ID, Symbol, Currency, Report Date and Quantity for every share award/return.",
        );
      }
      const day = date.toISOString().slice(0, 10);
      if (day < from || day > to) {
        throw new Error(
          "IBKR grant receipt is outside the requested statement period.",
        );
      }
      const identity = JSON.stringify([
        header.accountId,
        attrs.symbol,
        attrs.currency,
        day,
        quantity,
      ]);
      const occurrence = occurrences.get(identity) ?? 0;
      occurrences.set(identity, occurrence + 1);
      const key = createHash("sha256").update(
        JSON.stringify([identity, occurrence]),
      ).digest("hex");
      const order: IntegrationOrder = {
        integrationId: integration.id,
        integrationKind: "ibkr",
        account: header.accountId,
        ticker: attrs.symbol.trim(),
        currency: attrs.currency,
        assetCategory: "STK",
        date,
        quantity,
        price: 0,
        commission: { amount: 0, currency: attrs.currency },
        receipt: "gift",
        transactionKey: JSON.stringify(["ibkr-grant", integration.id, key]),
        ...(attrs.isin ? { isin: attrs.isin } : {}),
      };
      return { key, day, order };
    },
  );
  ensureSchema(database);
  database.exec("BEGIN");
  try {
    database.prepare(
      "DELETE FROM ibkr_stock_grants WHERE integration_id=? AND query_id=? AND report_date>=? AND report_date<=?",
    )
      .run(integration.id, queryId, from, to);
    const insert = database.prepare(
      "INSERT INTO ibkr_stock_grants VALUES (?,?,?,?,?)",
    );
    for (const grant of grants) {
      if (grant.order.quantity !== 0) {
        insert.run(
          integration.id,
          queryId,
          grant.key,
          grant.day,
          JSON.stringify(grant.order),
        );
      }
    }
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

export function readIbkrStockGrants(
  database: Database,
  integration: Integration,
): IntegrationOrder[] {
  ensureSchema(database);
  const credentials = parseIbkrCredentials(integration.credentials);
  const queries = new Set([
    credentials.flexQueryId,
    credentials.fundingFlexQueryId,
  ]);
  const grants = new Map<string, IntegrationOrder>();
  const rows = database.prepare(
    "SELECT query_id,payload FROM ibkr_stock_grants WHERE integration_id=? ORDER BY report_date,grant_key",
  )
    .all(integration.id) as { query_id: string; payload: string }[];
  for (const row of rows) {
    if (queries.has(row.query_id)) {
      const order = JSON.parse(row.payload) as IntegrationOrder;
      if (credentials.accountId && order.account !== credentials.accountId) {
        continue;
      }
      // Flex trade history uses the integration's account identity (empty account
      // label), so awards and later sales must share that same FIFO ledger.
      grants.set(order.transactionKey!, {
        ...order,
        account: "",
        date: new Date(order.date),
      });
    }
  }
  return [...grants.values()];
}
