import type { Integration } from "../../database/integration.ts";
import type { Database } from "../../database/setup.ts";
import type { IntegrationAccountPerformance } from "../types.ts";
import {
  getFlexStatement,
  getFlexStatementRange,
  getXmlElements,
  parseDate,
} from "./flex.ts";
import { parseIbkrCredentials } from "./credentials.ts";

type Attributes = Record<string, string>;
const configurationError =
  "IBKR funding requires an XML Activity Flex Query with Account Information (Account ID, Currency, Date Opened, Date Funded), Cash Transactions (Account ID, Currency, FX Rate to Base, Report Date, Date/Time, Amount, Type, Transaction ID), Cash Report (Base Currency Summary, deposits, withdrawals, starting/ending cash) and Change in NAV (starting value, deposits/withdrawals). The configured query only supplies trades or omits required funding fields.";
function requiredNumber(value: string | undefined, field: string) {
  if (value === undefined || !value.trim() || !Number.isFinite(Number(value))) {
    throw new Error(
      `IBKR funding report is missing ${field}. ${configurationError}`,
    );
  }
  return Number(value);
}
function requiredDate(value: string | undefined, field: string) {
  const result = parseDate(value ?? null);
  const normalized = value?.match(/^(\d{4}-\d{2}-\d{2}|\d{8})/)?.[1].replaceAll(
    "-",
    "",
  );
  if (
    !result || !Number.isFinite(+result) ||
    result.toISOString().slice(0, 10).replaceAll("-", "") !== normalized
  ) {
    throw new Error(
      `IBKR funding report is missing a valid ${field}. ${configurationError}`,
    );
  }
  return result;
}
function one(rows: { attrs: Attributes }[], field: string): Attributes {
  if (rows.length !== 1) {
    throw new Error(
      `IBKR funding requires exactly one ${field} for the selected account. ${configurationError}`,
    );
  }
  return rows[0].attrs;
}
export type IbkrFundingBatch = {
  accountId: string;
  currency: string;
  openedAt: string;
  fundedAt?: string;
  from: string;
  through: string;
  deposits: number;
  withdrawals: number;
  fundingHistory: { date: string; amount: number }[];
  cashHistory: NonNullable<IntegrationAccountPerformance["cashHistory"]>;
  startingCash: number;
  endingCash: number;
  startingValue: number;
  startingCashByCurrency?: Record<string, number>;
  endingCashByCurrency?: Record<string, number>;
};
export function parseIbkrFundingBatch(
  xml: string,
  range: { from: Date; to: Date },
  accountId?: string,
): IbkrFundingBatch {
  if (!/<FlexQueryResponse\b[^>]*\btype=["']AF["']/.test(xml)) {
    throw new Error(configurationError);
  }
  const statements = [
    ...xml.matchAll(/<FlexStatement\b([^>]*)>([\s\S]*?)<\/FlexStatement>/g),
  ];
  const selected = statements.filter((match) => {
    const attrs = getXmlElements(`<FlexStatement ${match[1]}>`, [
      "FlexStatement",
    ])[0]?.attrs;
    return !accountId || attrs?.accountId === accountId;
  });
  if (selected.length !== 1) {
    throw new Error(
      "IBKR funding query must include exactly the Gateway account; select it in the Flex Query settings",
    );
  }
  const [statement] = selected;
  const header = one(
    getXmlElements(`<FlexStatement ${statement[1]}>`, ["FlexStatement"]),
    "statement",
  );
  const body = statement[2];
  const from = requiredDate(header.fromDate, "statement fromDate");
  const through = requiredDate(header.toDate, "statement toDate");
  const info = one(
    getXmlElements(body, ["AccountInformation"]),
    "Account Information row",
  );
  if (
    !header.accountId || (info.accountId && header.accountId !== info.accountId)
  ) throw new Error("IBKR funding account identity mismatch");
  const openedAt = requiredDate(info.dateOpened, "account dateOpened");
  const fundedAt = info.dateFunded?.trim()
    ? requiredDate(info.dateFunded, "account dateFunded")
    : undefined;
  if (fundedAt && (fundedAt < openedAt || fundedAt > through)) {
    throw new Error("IBKR account funding date is outside its lifetime");
  }
  const currency = info.currency?.toUpperCase();
  if (!currency || !/^[A-Z]{3}$/.test(currency)) {
    throw new Error(configurationError);
  }
  const historyStart = fundedAt ?? openedAt;
  const expectedFrom = range.from > historyStart ? range.from : historyStart;
  if (
    from > expectedFrom || through < range.to || through > range.to ||
    from < range.from
  ) {
    throw new Error(
      "IBKR funding query returned a truncated or overlapping period; enable custom date ranges",
    );
  }
  if (!/<CashTransactions\b/.test(body)) throw new Error(configurationError);
  const nav = one(getXmlElements(body, ["ChangeInNAV"]), "Change in NAV row");
  const cashRows = getXmlElements(body, ["CashReportCurrency"]);
  const cash = one(
    cashRows.filter((r) => r.attrs.currency === "BASE_SUMMARY")
      .concat(
        cashRows.some((r) => r.attrs.currency === "BASE_SUMMARY")
          ? []
          : cashRows.filter((r) => r.attrs.currency === currency),
      ),
    "base-currency Cash Report row",
  );
  for (const attrs of [info, nav, cash]) {
    if (attrs.accountId && attrs.accountId !== header.accountId) {
      throw new Error("IBKR funding account identity mismatch");
    }
  }
  // Account/security transfers are separate from cash deposits in IBKR's NAV
  // totals. Without their contribution basis, treating them as P/L is unsafe.
  for (
    const [attrs, fields] of [
      [nav, [
        "assetTransfers",
        "internalCashTransfers",
        "paxosTransfers",
        "excessFundSweep",
        "linkingAdjustments",
        "grantActivity",
      ]],
      [cash, [
        "accountTransfers",
        "internalTransfers",
        "paxosTransfers",
        "excessFundSweep",
        "linkingAdjustments",
      ]],
    ] as const
  ) {
    for (const field of fields) {
      if (
        attrs[field] !== undefined &&
        Math.abs(requiredNumber(attrs[field], field)) > .005
      ) {
        throw new Error(
          "IBKR security/account transfers require verified contribution values before an account return can be calculated",
        );
      }
    }
  }
  const externalTypes = new Set([
    "Deposits/Withdrawals",
    "Deposits & Withdrawals",
    "Deposit",
    "Withdrawal",
  ]);
  // Income and costs stay in account P/L; they are not new external funding.
  const otherTypes = new Set([
    "Dividends",
    "Withholding Tax",
    "Broker Interest Paid",
    "Broker Interest Received",
    "Other Fees",
    "Other Income",
    "Payment In Lieu Of Dividends",
    "Bond Interest Paid",
    "Bond Interest Received",
    "Transaction Tax",
    "Commission Adjustments",
    "Sales Tax",
  ]);
  const seen = new Map<string, string>();
  let deposits = 0, withdrawals = 0;
  const fundingHistory: { date: string; amount: number }[] = [];
  const cashHistory: NonNullable<IntegrationAccountPerformance["cashHistory"]> = [];
  for (const { attrs } of getXmlElements(body, ["CashTransaction"])) {
    if (attrs.accountId && attrs.accountId !== header.accountId) {
      throw new Error(
        "IBKR funding contains another account's cash transaction",
      );
    }
    if (attrs.levelOfDetail && attrs.levelOfDetail !== "DETAIL") {
      throw new Error(
        "IBKR Cash Transactions must use detail rows, not summaries",
      );
    }
    if (!otherTypes.has(attrs.type) && !externalTypes.has(attrs.type)) {
      throw new Error(
        `Unsupported IBKR cash transaction type: ${attrs.type || "missing"}`,
      );
    }
    // Statement membership uses the broker's report date. A late-night
    // transaction can have a timestamp on the preceding calendar day.
    const at = requiredDate(
      attrs.reportDate ?? attrs.dateTime,
      "cash transaction report date",
    );
    if (at < from || at > through) {
      throw new Error(
        "IBKR funding cash transaction is outside the report period",
      );
    }
    const id = attrs.transactionID ?? attrs.transactionId;
    if (!id) {
      throw new Error(
        `IBKR funding transaction ID is missing. ${configurationError}`,
      );
    }
    const serialized = JSON.stringify(attrs);
    if (seen.has(id)) {
      if (seen.get(id) !== serialized) {
        throw new Error("Conflicting IBKR funding transactions");
      }
      continue;
    }
    seen.set(id, serialized);
    const native = requiredNumber(attrs.amount, "cash transaction amount");
    if (!/^[A-Z]{3}$/.test(attrs.currency)) throw new Error("Invalid IBKR cash transaction currency");
    cashHistory.push({ date: at.toISOString().slice(0, 10), currency: attrs.currency,
      amount: native, type: attrs.type, reference: id });
    if (otherTypes.has(attrs.type)) continue;
    const rate = attrs.currency === currency
      ? 1
      : requiredNumber(attrs.fxRateToBase, "cash transaction FX Rate to Base");
    if (!attrs.currency || rate <= 0) {
      throw new Error("Invalid IBKR funding currency conversion");
    }
    const amount = native * rate;
    fundingHistory.push({ date: at.toISOString().slice(0, 10), amount });
    if (amount >= 0) deposits += amount;
    else withdrawals -= amount;
  }
  // Cross-check against independent broker totals; filtered/partial transaction
  // sections must never silently turn into zero lifetime contributions.
  const net = deposits - withdrawals;
  const navFunding = requiredNumber(
    nav.depositsWithdrawals,
    "Change in NAV depositsWithdrawals",
  );
  const cashDeposits = requiredNumber(cash.deposits, "Cash Report deposits");
  const cashWithdrawals = Math.abs(
    requiredNumber(cash.withdrawals, "Cash Report withdrawals"),
  );
  const close = (a: number, b: number) => Math.abs(a - b) <= .02;
  if (
    !close(net, navFunding) || !close(deposits, cashDeposits) ||
    !close(withdrawals, cashWithdrawals)
  ) {
    throw new Error(
      "IBKR funding transactions do not reconcile with Cash Report and Change in NAV; remove report filters and include all funding transactions",
    );
  }
  for (const { attrs } of getXmlElements(body, ["Transfer"])) {
    if (
      requiredNumber(attrs.quantity ?? "0", "transfer quantity") !== 0 ||
      requiredNumber(
          attrs.cashTransfer ?? attrs.cashAmount ?? "0",
          "cash transfer amount",
        ) !== 0
    ) {
      throw new Error(
        "IBKR security/account transfers require verified contribution values before an account return can be calculated",
      );
    }
  }
  const startingCashByCurrency: Record<string, number> = {};
  const endingCashByCurrency: Record<string, number> = {};
  for (
    const { attrs } of cashRows.filter(({ attrs }) =>
      /^[A-Z]{3}$/.test(attrs.currency)
    )
  ) {
    if (attrs.accountId && attrs.accountId !== header.accountId) {
      throw new Error("IBKR funding account identity mismatch");
    }
    if (attrs.currency in endingCashByCurrency) {
      throw new Error(
        "IBKR Cash Report must exclude segments and MTD/YTD breakout",
      );
    }
    startingCashByCurrency[attrs.currency] = requiredNumber(
      attrs.startingCash,
      "native starting cash",
    );
    endingCashByCurrency[attrs.currency] = requiredNumber(
      attrs.endingCash,
      "native ending cash",
    );
  }
  return {
    accountId: header.accountId,
    currency,
    openedAt: openedAt.toISOString(),
    ...(fundedAt ? { fundedAt: fundedAt.toISOString() } : {}),
    from: from.toISOString(),
    through: through.toISOString(),
    deposits,
    withdrawals,
    fundingHistory,
    cashHistory,
    startingCash: requiredNumber(cash.startingCash, "starting cash"),
    endingCash: requiredNumber(cash.endingCash, "ending cash"),
    startingValue: requiredNumber(nav.startingValue, "starting account value"),
    ...(Object.keys(endingCashByCurrency).length
      ? { startingCashByCurrency, endingCashByCurrency }
      : {}),
  };
}

export type IbkrAccountSnapshot = {
  accountId: string;
  currency: string;
  totalValue: number;
  cash: number;
  cashByCurrency?: Record<string, number>;
};
function cashMatches(a: Record<string, number>, b: Record<string, number>) {
  return [...new Set([...Object.keys(a), ...Object.keys(b)])].every(
    (currency) =>
      Number.isFinite(a[currency] ?? 0) && Number.isFinite(b[currency] ?? 0) &&
      Math.abs((a[currency] ?? 0) - (b[currency] ?? 0)) <= .02,
  );
}
export async function fetchIbkrAccountPerformance(
  database: Database,
  integration: Integration,
  snapshot: IbkrAccountSnapshot,
  requestStatement = getFlexStatement,
  now = new Date(),
): Promise<IntegrationAccountPerformance> {
  const credentials = parseIbkrCredentials(integration.credentials);
  const token = credentials.flexToken;
  const queryId = credentials.fundingFlexQueryId ?? credentials.flexQueryId;
  if (!token || !queryId) throw new Error(configurationError);
  database.exec(`CREATE TABLE IF NOT EXISTS ibkr_funding_batches (
    integration_id INTEGER NOT NULL, query_id TEXT NOT NULL, from_date TEXT NOT NULL,
    to_date TEXT NOT NULL, payload TEXT NOT NULL, fetched_at REAL NOT NULL,
    PRIMARY KEY (integration_id, query_id, from_date, to_date))`);
  const latestRange = getFlexStatementRange(0, now);
  const loadBatch = async (range: { from: Date; to: Date }) => {
    const from = range.from.toISOString(), to = range.to.toISOString();
    const cached = database.prepare(
      "SELECT payload,fetched_at FROM ibkr_funding_batches WHERE integration_id=? AND query_id=? AND from_date=? AND to_date=?",
    )
      .get(integration.id, queryId, from, to) as {
        payload: string;
        fetched_at: number;
      } | undefined;
    const ttl = +range.to === +latestRange.to ? 60_000 : 86_400_000;
    const batch: IbkrFundingBatch =
      cached && Date.now() - cached.fetched_at < ttl && Array.isArray(JSON.parse(cached.payload).cashHistory)
        ? JSON.parse(cached.payload)
        : parseIbkrFundingBatch(
          await requestStatement(token, queryId, range),
          range,
          snapshot.accountId,
        );
    if (!cached || Date.now() - cached.fetched_at >= ttl || !Array.isArray(JSON.parse(cached.payload).cashHistory)) {
      database.prepare(
        "INSERT OR REPLACE INTO ibkr_funding_batches VALUES (?,?,?,?,?,?)",
      )
        .run(
          integration.id,
          queryId,
          from,
          to,
          JSON.stringify(batch),
          Date.now(),
        );
    }
    return batch;
  };
  const metadata = await loadBatch(latestRange);
  if (
    metadata.accountId !== snapshot.accountId ||
    metadata.currency !== snapshot.currency
  ) {
    throw new Error(
      "IBKR funding statement does not match the live Gateway account and base currency",
    );
  }
  const start = new Date(metadata.fundedAt ?? metadata.openedAt);
  const ranges = [latestRange];
  if (start < latestRange.from) {
    // Anchor full years at first funding. A backwards scan can leave only the
    // late-night funding date as its oldest period, for which IBKR publishes no
    // statement until the next report day. Keep these days in the same batch.
    ranges.length = 0;
    for (let from = start; from <= latestRange.to;) {
      if (ranges.length >= 100) {
        throw new Error("IBKR funding history exceeds 100 annual statements");
      }
      const to = new Date(Math.min(+latestRange.to, +from + 364 * 86_400_000));
      ranges.push({ from, to });
      from = new Date(+to + 86_400_000);
    }
    ranges.reverse();
  }
  let latest: IbkrFundingBatch | undefined,
    previous: IbkrFundingBatch | undefined;
  let deposits = 0, withdrawals = 0;
  const fundingHistory: { date: string; amount: number }[] = [];
  const cashHistory: NonNullable<IntegrationAccountPerformance["cashHistory"]> = [];
  for (const range of ranges) {
    const batch = await loadBatch(range);
    if (
      batch.accountId !== snapshot.accountId ||
      batch.currency !== snapshot.currency ||
      (batch.openedAt !== metadata.openedAt ||
        batch.fundedAt !== metadata.fundedAt)
    ) {
      throw new Error(
        "IBKR funding statement does not match the live Gateway account and base currency",
      );
    }
    if (
      previous &&
      !(batch.endingCashByCurrency && previous.startingCashByCurrency
        ? cashMatches(
          batch.endingCashByCurrency,
          previous.startingCashByCurrency,
        )
        : Math.abs(batch.endingCash - previous.startingCash) <= .02)
    ) {
      throw new Error(
        "IBKR funding history has a cash discontinuity between annual statements",
      );
    }
    latest ??= batch;
    previous = batch;
    deposits += batch.deposits;
    withdrawals += batch.withdrawals;
    fundingHistory.push(...batch.fundingHistory);
    cashHistory.push(...batch.cashHistory);
    if (range.from <= new Date(batch.fundedAt ?? batch.openedAt)) {
      if (
        Math.abs(batch.startingValue) > .005 ||
        Math.abs(batch.startingCash) > .005 ||
        Object.values(batch.startingCashByCurrency ?? {}).some((value) =>
          Math.abs(value) > .005
        )
      ) {
        throw new Error(
          "IBKR account starts with assets; lifetime contributions are incomplete",
        );
      }
      // Funding is only published through the last completed day. Any cash
      // change since that snapshot could be a new deposit/withdrawal; the trade
      // API cannot distinguish it. Never silently use yesterday's funding.
      if (
        !(snapshot.cashByCurrency && latest.endingCashByCurrency
          ? cashMatches(snapshot.cashByCurrency, latest.endingCashByCurrency)
          : Math.abs(snapshot.cash - latest.endingCash) <= .02)
      ) {
        throw new Error(
          "IBKR live cash differs from the latest completed Flex statement; today's cash activity cannot yet be reconciled. Retry after the next daily statement.",
        );
      }
      const netContributions = deposits - withdrawals;
      return {
        integrationId: integration.id,
        currency: snapshot.currency,
        totalValue: snapshot.totalValue,
        cash: snapshot.cash,
        pnl: snapshot.totalValue - netContributions,
        deposits,
        withdrawals,
        fundingHistory,
        cashHistory,
        netContributions,
        ledgerCash: snapshot.cashByCurrency ?? { [snapshot.currency]: snapshot.cash },
        openedAt: new Date(batch.openedAt),
        historyThrough: new Date(latest.through),
        positionValue: snapshot.totalValue - snapshot.cash,
        investmentValue: snapshot.totalValue - snapshot.cash,
      };
    }
  }
  throw new Error("IBKR funding history exceeds 100 annual statements");
}
