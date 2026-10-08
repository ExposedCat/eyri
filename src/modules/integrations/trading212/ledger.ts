import type { Database } from "../../database/setup.ts";
import type { Integration } from "../../database/integration.ts";
import type {
  IntegrationAccountPerformance,
  IntegrationCashTransaction,
  IntegrationOrder,
  IntegrationPortfolioPosition,
} from "../types.ts";
import { getTrading212Client } from "./api.ts";
import { parseTrading212Credentials } from "./credentials.ts";
import { fetchTrading212CashHistory } from "./transactions.ts";
import { isCfdAllocation } from "../../tickers/cfd_history.ts";

type Row = Record<string, string>;
class LedgerMismatch extends Error {}
// CSV exports carry the distinction the cash API loses: conversions and tax
// refunds are labelled DEPOSIT there, but are not external contributions.
export function parseTrading212Csv(csv: string): Row[] {
  const records: string[][] = [];
  let record: string[] = [], field = "", quoted = false;
  csv = csv.replace(/^\uFEFF/, "");
  for (let i = 0; i < csv.length; i++) {
    const ch = csv[i];
    if (ch === '"') {
      if (quoted && csv[i + 1] === '"') {
        field += '"';
        i++;
      } else if (quoted || field === "") quoted = !quoted;
      else throw new Error("Malformed Trading 212 CSV quote");
    } else if (!quoted && (ch === "," || ch === "\n" || ch === "\r")) {
      record.push(field);
      field = "";
      if (ch !== ",") {
        if (record.some(Boolean)) records.push(record);
        record = [];
        if (ch === "\r" && csv[i + 1] === "\n") i++;
      }
    } else field += ch;
  }
  if (quoted) throw new Error("Unterminated Trading 212 CSV field");
  if (field || record.length) {
    record.push(field);
    records.push(record);
  }
  const headers = records.shift();
  if (
    !headers || new Set(headers).size !== headers.length ||
    ![
      "Action",
      "Time (UTC)",
      "ISIN",
      "Gross Total",
      "Currency (Gross Total)",
    ].every((h) => headers.includes(h))
  ) {
    throw new Error("Invalid Trading 212 CSV headers");
  }
  // Empty and dividend-only exports omit optional columns, including ID.
  // Trades and funding transfers still require IDs to reconcile them safely.
  if (!records.length) return [];
  return records.map((r) => {
    if (r.length !== headers.length) {
      throw new Error("Invalid Trading 212 CSV row");
    }
    const row = Object.fromEntries(headers.map((h, i) => [h, r[i]]));
    if (
      (!row.ID) &&
      (/ (buy|sell)$/.test(row.Action) ||
        ["Deposit", "Withdrawal"].includes(row.Action))
    ) {
      throw new Error("Trading 212 CSV events are missing IDs");
    }
    return row;
  });
}

function number(value: string, label: string) {
  if (
    !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(value) ||
    !Number.isFinite(Number(value))
  ) {
    throw new Error(`Invalid Trading 212 CSV ${label}`);
  }
  return Number(value);
}

export function buildTrading212Ledger(rows: Row[], transfers: Set<string>) {
  const cash: Record<string, number> = {},
    deposits: Record<string, number> = {},
    withdrawals: Record<string, number> = {};
  const quantities: Record<string, number> = {};
  let openedAt: Date | null = null;
  const add = (
    target: Record<string, number>,
    currency: string,
    amount: number,
  ) => {
    if (!/^[A-Z]{3}$/.test(currency)) {
      throw new Error("Invalid Trading 212 CSV currency");
    }
    target[currency] = (target[currency] ?? 0) + amount;
  };
  const seen = new Map<string, string>();
  for (const row of rows) {
    const timestamp = row["Time (UTC)"].replace(" ", "T");
    const date = new Date(
      timestamp + (/(Z|[+-]\d{2}:?\d{2})$/.test(timestamp) ? "" : "Z"),
    );
    if (!Number.isFinite(+date)) {
      throw new Error("Invalid Trading 212 CSV date");
    }
    // Chunk boundaries can repeat rows; duplicates must agree rather than count twice.
    const key = JSON.stringify([
      row.Action,
      row.ID ?? "",
      row["Time (UTC)"],
      row.ISIN,
    ]);
    // Export columns depend on the actions present in each interval. Missing
    // optional columns and empty values must compare equally across overlaps.
    const serialized = JSON.stringify(
      Object.entries(row).filter(([, value]) => value !== "")
        .sort(([a], [b]) => a.localeCompare(b)),
    );
    if (seen.has(key)) {
      if (seen.get(key) !== serialized) {
        throw new Error("Conflicting Trading 212 CSV rows");
      }
      continue;
    }
    seen.set(key, serialized);
    if (!openedAt || date < openedAt) openedAt = date;
    if (row.Action === "Currency conversion") {
      add(
        cash,
        row["Currency (Currency conversion from amount)"],
        -number(row["Currency conversion from amount"], "conversion debit"),
      );
      add(
        cash,
        row["Currency (Currency conversion to amount)"],
        number(row["Currency conversion to amount"], "conversion credit"),
      );
      if (row["Currency conversion fee"]) {
        add(
          cash,
          row["Currency (Currency conversion fee)"],
          number(row["Currency conversion fee"], "conversion fee"),
        );
      }
      continue;
    }
    const field = row["Net Total"] ? "Net Total" : "Gross Total";
    const value = number(row[field], field);
    const currency = row[`Currency (${field})`];
    if (/^(Market|Limit|Stop|Stop limit) (buy|sell)$/.test(row.Action)) {
      if (!row.ISIN) throw new Error("Trading 212 CSV trade is missing ISIN");
      const buy = row.Action.endsWith(" buy");
      add(cash, currency, (buy ? -1 : 1) * value);
      quantities[row.ISIN] = (quantities[row.ISIN] ?? 0) +
        (buy ? 1 : -1) * number(row["No. of shares"], "shares");
      // Gross/Net Total already includes execution taxes and FX fees.
    } else if (
      ["Deposit", "Withdrawal", "Tax Adjustment"].includes(row.Action) ||
      /^(Dividend|Interest)\b/.test(row.Action)
    ) {
      add(cash, currency, value);
      if (!transfers.has(row.ID)) {
        if (row.Action === "Deposit") add(deposits, currency, value);
        if (row.Action === "Withdrawal") add(withdrawals, currency, -value);
      }
    } else throw new Error(`Unsupported Trading 212 CSV action: ${row.Action}`);
  }
  return { cash, deposits, withdrawals, quantities, openedAt };
}

export type Trading212AccountSummary = {
  currency: string;
  totalValue: number;
  cash: { availableToTrade: number; reservedForOrders: number; inPies: number };
  investments: {
    currentValue: number;
    totalCost: number;
    realizedProfitLoss: number;
    unrealizedProfitLoss: number;
  };
};

export function reconcileTrading212Account(
  integrationId: number,
  rows: Row[],
  transactions: IntegrationCashTransaction[],
  positions: IntegrationPortfolioPosition[],
  summary: Trading212AccountSummary,
  historyThrough: Date,
  orders?: IntegrationOrder[],
): IntegrationAccountPerformance {
  const ledger = buildTrading212Ledger(
    rows,
    new Set(
      transactions.filter((t) => t.type === "TRANSFER").map((t) => t.reference),
    ),
  );
  const currency = summary.currency;
  const cash = summary.cash.availableToTrade + summary.cash.reservedForOrders +
    summary.cash.inPies;
  if (
    !/^[A-Z]{3}$/.test(currency) ||
    ![summary.totalValue, cash, summary.investments.currentValue].every(
      Number.isFinite,
    )
  ) {
    throw new Error("Invalid Trading 212 account summary");
  }
  const contributions = (amounts: Record<string, number>) => {
    if (
      Object.entries(amounts).some(([c, v]) =>
        c !== currency && Math.abs(v) > 1e-8
      )
    ) {
      throw new Error(
        "Exact account return requires historical FX for external funding in other currencies",
      );
    }
    return amounts[currency] ?? 0;
  };
  const deposits = contributions(ledger.deposits),
    withdrawals = contributions(ledger.withdrawals);
  const netContributions = deposits - withdrawals;
  if (
    Object.entries(ledger.cash).some(([c, v]) =>
      c !== currency && Math.abs(v) > 1e-8
    )
  ) {
    throw new Error(
      "Cannot reconcile Trading 212 cash: non-account-currency cash requires a broker currency breakdown",
    );
  }
  if (
    Math.round((ledger.cash[currency] ?? 0) * 100) !== Math.round(cash * 100)
  ) {
    throw new LedgerMismatch(
      `Trading 212 cash history does not reconcile: ledger ${
        (ledger.cash[currency] ?? 0).toFixed(2)
      }, broker ${cash.toFixed(2)} ${currency}. Refresh the export.`,
    );
  }
  const actual: Record<string, number> = {};
  let positionValue = 0;
  for (const p of positions) {
    if (isCfdAllocation(p) && p.amount !== 0) {
      throw new Error(
        "Exact combined account return requires the current CFD account value; transfer funding is not a valuation",
      );
    }
    if (!p.isin) throw new Error(`Cannot reconcile ${p.ticker}: missing ISIN`);
    actual[p.isin] = (actual[p.isin] ?? 0) + p.amount;
    const value = p.brokerValuations?.find((v) => v.currency === currency)
      ?.totalNow;
    if (value == null) {
      throw new Error(
        `Cannot reconcile ${p.ticker}: missing broker wallet value`,
      );
    }
    positionValue += value;
  }
  for (
    const isin of new Set([
      ...Object.keys(actual),
      ...Object.keys(ledger.quantities),
    ])
  ) {
    if (Math.abs((actual[isin] ?? 0) - (ledger.quantities[isin] ?? 0)) > 1e-7) {
      throw new LedgerMismatch(
        `Trading 212 share history does not reconcile for ${isin}; refresh the complete export`,
      );
    }
  }
  if (!ledger.openedAt) throw new Error("Trading 212 funding history is empty");
  if (orders) {
    const exported = new Set(
      rows.filter((r) => / (buy|sell)$/.test(r.Action)).map((r) => r.ID),
    );
    const imported = new Set(
      orders.filter((o) => !isCfdAllocation(o)).map((o) =>
        `EOF${o.executionId}`
      ),
    );
    if (
      exported.size !== imported.size ||
      [...exported].some((id) => !imported.has(id))
    ) {
      throw new Error(
        "Trading 212 execution history does not match the complete CSV export",
      );
    }
  }
  return {
    integrationId,
    currency,
    totalValue: summary.totalValue,
    deposits,
    withdrawals,
    netContributions,
    pnl: summary.totalValue - netContributions,
    cash,
    ledgerCash: ledger.cash,
    openedAt: ledger.openedAt,
    historyThrough,
    positionValue,
    investmentValue: summary.investments.currentValue,
  };
}

type Export = {
  reportId: number;
  status: string;
  timeFrom: string;
  timeTo: string;
  downloadLink?: string;
  dataIncluded: {
    includeDividends: boolean;
    includeInterest: boolean;
    includeOrders: boolean;
    includeTransactions: boolean;
  };
};
const included = {
  includeDividends: true,
  includeInterest: true,
  includeOrders: true,
  includeTransactions: true,
};
const DAY = 86400000;
const pending = new WeakMap<
  Database,
  Map<number, Promise<IntegrationAccountPerformance>>
>();

async function fetchAccount(
  db: Database,
  integration: Integration,
  positions: IntegrationPortfolioPosition[],
  orders: IntegrationOrder[],
) {
  const transactions = await fetchTrading212CashHistory(db, integration);
  const dates = [
    ...transactions.map((t) => +t.date),
    ...orders.filter((o) => !isCfdAllocation(o)).map((o) => +o.date),
  ];
  if (!dates.length) {
    throw new Error(
      "Complete Trading 212 history is required for account return",
    );
  }
  const from = Math.floor(Math.min(...dates) / DAY) * DAY;
  const client = getTrading212Client(
    parseTrading212Credentials(integration.credentials),
  );
  db.exec(`CREATE TABLE IF NOT EXISTS trading212_ledger_exports (
    integration_id INTEGER NOT NULL REFERENCES integrations(id) ON DELETE CASCADE,
    time_from TEXT NOT NULL, time_to TEXT NOT NULL, csv TEXT NOT NULL, fetched_at REAL NOT NULL,
    PRIMARY KEY (integration_id, time_from)
  ); CREATE TABLE IF NOT EXISTS trading212_ledger_requests (
    integration_id INTEGER NOT NULL REFERENCES integrations(id) ON DELETE CASCADE,
    time_from TEXT NOT NULL, report_id REAL NOT NULL,
    PRIMARY KEY (integration_id, time_from)
  )`);
  const through = Date.now();
  let exports: Export[] | undefined;
  const rows: Row[] = [];
  let historyThrough = through;
  let usedCachedCurrent = false;
  const requestExport = async (
    timeFrom: string,
    timeTo: string,
  ): Promise<never> => {
    const created = await client.requestReport({
      timeFrom,
      timeTo,
      dataIncluded: included,
    });
    if (!Number.isSafeInteger(created.reportId)) {
      throw new Error("Invalid Trading 212 export report ID");
    }
    db.prepare(`INSERT INTO trading212_ledger_requests VALUES (?, ?, ?)
      ON CONFLICT(integration_id,time_from) DO UPDATE SET report_id=excluded.report_id`)
      .run(integration.id, timeFrom, created.reportId);
    throw new Error(
      "Trading 212 is preparing the complete cash-and-trade export. Retry this report in a minute.",
    );
  };
  // Reports have a one-year maximum. Overlapping export rows are deduplicated
  // by stable event identity before any ledger totals are calculated.
  for (let start = from; start < through; start += 364 * DAY) {
    const end = Math.min(start + 364 * DAY, through);
    const timeFrom = new Date(start).toISOString(),
      timeTo = new Date(end).toISOString();
    const cached = db.prepare(
      "SELECT * FROM trading212_ledger_exports WHERE integration_id = ? AND time_from = ?",
    ).get(integration.id, timeFrom) as {
      time_to: string;
      csv: string;
      fetched_at: number;
    } | undefined;
    // Reuse event history while no known event has moved beyond coverage.
    // Fresh summary cash and share counts below independently validate reuse.
    const latestInPeriod = Math.max(
      start,
      ...dates.filter((d) => d >= start && d <= end),
    );
    if (cached && +new Date(cached.time_to) >= latestInPeriod) {
      rows.push(...parseTrading212Csv(cached.csv));
      historyThrough = +new Date(cached.time_to);
      if (end === through) usedCachedCurrent = true;
      continue;
    }
    exports ??= await client.get<Export[]>("/api/v0/equity/history/exports");
    if (!Array.isArray(exports)) {
      throw new Error("Invalid Trading 212 export list");
    }
    const requested = db.prepare(
      "SELECT report_id FROM trading212_ledger_requests WHERE integration_id = ? AND time_from = ?",
    ).get(integration.id, timeFrom) as { report_id: number } | undefined;
    const report = exports.filter((r) =>
      +new Date(r.timeFrom) <= start &&
      (r.reportId === requested?.report_id ||
        +new Date(r.timeTo) >= end - 60_000) &&
      Object.keys(included).every((k) =>
        r.dataIncluded?.[k as keyof typeof included]
      )
    ).sort((a, b) => +new Date(b.timeTo) - +new Date(a.timeTo))[0];
    if (!report) {
      return await requestExport(timeFrom, timeTo);
    }
    if (report.status !== "Finished" || !report.downloadLink) {
      if (["Failed", "Canceled"].includes(report.status)) {
        db.prepare(
          "DELETE FROM trading212_ledger_requests WHERE integration_id = ? AND time_from = ?",
        ).run(integration.id, timeFrom);
        throw new Error(
          "Trading 212 cash-and-trade export failed. Retry to request a new export.",
        );
      }
      throw new Error(
        "Trading 212 is preparing the complete cash-and-trade export. Retry this report in a minute.",
      );
    }
    const link = new URL(report.downloadLink);
    if (link.protocol !== "https:" || link.username || link.password) {
      throw new Error("Invalid Trading 212 download link");
    }
    // Signed export download is deliberately unauthenticated. Never send the API key.
    const response = await fetch(link, {
      signal: AbortSignal.timeout(20_000),
      redirect: "error",
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error("Trading 212 export download failed");
    }
    const csv = await response.text();
    rows.push(...parseTrading212Csv(csv));
    db.prepare(`INSERT INTO trading212_ledger_exports VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(integration_id,time_from) DO UPDATE SET time_to=excluded.time_to,csv=excluded.csv,fetched_at=excluded.fetched_at`)
      .run(integration.id, timeFrom, report.timeTo, csv, Date.now());
    db.prepare(
      "DELETE FROM trading212_ledger_requests WHERE integration_id = ? AND time_from = ?",
    ).run(integration.id, timeFrom);
    historyThrough = +new Date(report.timeTo);
  }
  const summary = await client.get<Trading212AccountSummary>(
    "/api/v0/equity/account/summary",
  );
  try {
    return reconcileTrading212Account(
      integration.id,
      rows,
      transactions,
      positions,
      summary,
      new Date(historyThrough),
      orders,
    );
  } catch (error) {
    if (error instanceof LedgerMismatch && usedCachedCurrent) {
      const start = from +
        Math.floor((through - from) / (364 * DAY)) * 364 * DAY;
      const timeFrom = new Date(start).toISOString();
      db.prepare(
        "DELETE FROM trading212_ledger_exports WHERE integration_id = ? AND time_from = ?",
      ).run(integration.id, timeFrom);
      await requestExport(timeFrom, new Date(through).toISOString());
    }
    throw error;
  }
}

export function fetchTrading212AccountPerformance(
  db: Database,
  integration: Integration,
  positions: IntegrationPortfolioPosition[],
  orders: IntegrationOrder[],
) {
  let requests = pending.get(db);
  if (!requests) {
    requests = new Map();
    pending.set(db, requests);
  }
  const existing = requests.get(integration.id);
  if (existing) return existing;
  const request = fetchAccount(db, integration, positions, orders).finally(() =>
    requests!.delete(integration.id)
  );
  requests.set(integration.id, request);
  return request;
}
