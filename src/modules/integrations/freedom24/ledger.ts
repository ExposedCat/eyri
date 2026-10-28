import type { Integration } from "../../database/integration.ts";
import type {
  IntegrationAccountPerformance,
  IntegrationPortfolioPosition,
} from "../types.ts";
import { makeTradernetApiRequest } from "./api.ts";
import { parseFreedom24Credentials } from "./credentials.ts";

// Broker report fields, deliberately read as unknown until validated. The report
// is requested from 1970, independently of the order-history lookback setting.
type ObjectRow = Record<string, unknown>;
const fundingTypes = new Set([
  "bank",
  "card",
  "cash",
  "intercompany",
  "internal_holding",
  "digital_assets",
]);
const incomeTypes = new Set([
  "dividend",
  "tax",
  "interest",
  "coupon",
  "commission",
]);
function object(value: unknown, field: string): ObjectRow {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Incomplete Freedom24 broker report: ${field}`);
  }
  return value as ObjectRow;
}
function rows(value: unknown, field: string): ObjectRow[] {
  if (!Array.isArray(value)) {
    throw new Error(`Incomplete Freedom24 broker report: ${field}`);
  }
  return value.map((v) => object(v, field));
}
function number(value: unknown, field: string): number {
  if (
    (typeof value !== "number" && typeof value !== "string") ||
    String(value).trim() === "" || !Number.isFinite(Number(value))
  ) {
    throw new Error(`Invalid Freedom24 broker report number: ${field}`);
  }
  return Number(value);
}
function date(value: unknown, field: string) {
  const text = typeof value === "string" ? value.slice(0, 10) : "";
  const result = new Date(`${text}T00:00:00Z`);
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(text) || !Number.isFinite(+result) ||
    result.toISOString().slice(0, 10) !== text
  ) {
    throw new Error(`Invalid Freedom24 broker report date: ${field}`);
  }
  return result;
}
function snapshot(value: unknown, field: string) {
  const account = object(object(value, field).account, `${field}.account`);
  const ps = object(
    object(account.positions_from_ts, `${field}.positions_from_ts`).ps,
    `${field}.ps`,
  );
  return {
    account,
    cash: rows(ps.acc, `${field}.acc`),
    positions: rows(ps.pos, `${field}.pos`),
  };
}

export function buildFreedom24AccountPerformance(
  integrationId: number,
  response: unknown,
  livePositions: IntegrationPortfolioPosition[],
  now = new Date(),
): IntegrationAccountPerformance {
  const report = object(object(response, "response").report, "report");
  const info = object(report.plainAccountInfoData, "plainAccountInfoData");
  const openedAt = date(info.client_date_open, "client_date_open");
  const startDate = date(report.date_start, "date_start");
  const through = date(report.date_end, "date_end");
  if (
    startDate > openedAt ||
    through.toISOString().slice(0, 10) !== now.toISOString().slice(0, 10)
  ) {
    throw new Error(
      "Freedom24 funding report does not cover the complete account lifetime through today",
    );
  }
  const start = snapshot(report.account_at_start, "account_at_start");
  const end = snapshot(report.account_at_end, "account_at_end");
  if (
    number(start.account.net_assets, "opening net assets") !== 0 ||
    start.cash.some((c) => number(c.s, "opening cash") !== 0) ||
    start.positions.some((p) => number(p.q, "opening quantity") !== 0)
  ) {
    throw new Error(
      "Freedom24 funding report starts with assets; lifetime funding is incomplete",
    );
  }
  // Historical USD funding is supplied by the broker for every transaction.
  // End-of-period assets/cash use the broker's current conversion to base.
  const base = String(info.base_currency).trim().toUpperCase();
  const usdRate = base === "USD" ? 1 : number(
    end.cash.find((c) => c.curr === "USD")?.cur_exchange_rate,
    "USD-to-base rate",
  );
  if (usdRate <= 0) throw new Error("Invalid Freedom24 USD-to-base rate");
  const ledgerCash: Record<string, number> = {};
  let cash = 0;
  for (const row of end.cash) {
    const currency = String(row.curr).trim().toUpperCase();
    if (!/^[A-Z]{3}$/.test(currency) || currency in ledgerCash) {
      throw new Error("Invalid or duplicate Freedom24 cash currency");
    }
    const amount = number(row.s, `${currency} cash`);
    ledgerCash[currency] = amount;
    const rate = currency === base
      ? 1
      : number(row.cur_exchange_rate, `${currency} rate`);
    if (rate <= 0) throw new Error(`Invalid Freedom24 rate for ${currency}`);
    cash += amount * rate / usdRate;
  }
  const flowRows = rows(report.cash_in_outs, "cash_in_outs");
  const detailed = rows(
    object(report.cash_flows, "cash_flows").detailed,
    "cash_flows.detailed",
  );
  if (flowRows.length !== detailed.length) {
    throw new Error("Freedom24 cash history is incomplete");
  }
  const seen = new Map<string, string>();
  const flowTotals = new Map<string, number>();
  let deposits = 0, withdrawals = 0;
  const fundingHistory: { date: string; amount: number }[] = [];
  let fundingIncludesTransfers = false;
  for (const row of flowRows) {
    if (
      number(row.approved, "cash approval") !== 1 ||
      number(row.reverted, "cash reversal") !== 0
    ) continue;
    if (
      number(row.phantom, "cash phantom flag") !== 0 ||
      (row.offbalance !== null && row.offbalance !== undefined &&
        Number(row.offbalance) !== 0)
    ) {
      throw new Error("Unsupported Freedom24 off-balance cash movement");
    }
    const id = String(row.id ?? "");
    if (!id) throw new Error("Freedom24 cash movement has no ID");
    const serialized = JSON.stringify(row);
    if (seen.has(id)) {
      if (seen.get(id) !== serialized) {
        throw new Error("Conflicting Freedom24 cash movements");
      }
      continue;
    }
    seen.set(id, serialized);
    const nativeAmount = number(row.amount, "native cash movement amount");
    const nativeCurrency = String(row.currency).toUpperCase();
    flowTotals.set(
      nativeCurrency,
      (flowTotals.get(nativeCurrency) ?? 0) + nativeAmount,
    );
    const type = String(row.type);
    if (incomeTypes.has(type)) continue;
    if (!fundingTypes.has(type)) {
      throw new Error(`Unsupported Freedom24 cash movement type: ${type}`);
    }
    const at = date(row.pay_d, "cash movement pay date");
    if (at < openedAt || at > through) {
      throw new Error(
        "Freedom24 cash movement falls outside the account report",
      );
    }
    const amount = number(row.value_usd, "historical funding USD value");
    const native = number(row.amount, "native funding amount");
    if ((native > 0) !== (amount > 0) || (native < 0) !== (amount < 0)) {
      throw new Error("Freedom24 funding currency signs disagree");
    }
    // Transfers between selected accounts cancel in the consolidated total.
    // A transfer into/out of a single selected account is funding for that account.
    fundingHistory.push({ date: at.toISOString().slice(0, 10), amount });
    if (["intercompany", "internal_holding"].includes(type)) fundingIncludesTransfers = true;
    if (amount >= 0) deposits += amount;
    else withdrawals -= amount;
  }
  const declaredTotals = object(
    object(report.cash_flows, "cash_flows").total,
    "cash_flows.total",
  );
  for (
    const currency of new Set([
      ...flowTotals.keys(),
      ...Object.keys(declaredTotals),
    ])
  ) {
    if (
      Math.abs(
        (flowTotals.get(currency) ?? 0) -
          number(declaredTotals[currency], `${currency} cash flow total`),
      ) > .02
    ) {
      throw new Error(
        `Freedom24 cash transactions do not reconcile with the broker total for ${currency}`,
      );
    }
  }
  const actual = new Map<string, number>();
  for (const p of livePositions) {
    actual.set(
      p.ticker.toUpperCase(),
      (actual.get(p.ticker.toUpperCase()) ?? 0) + p.amount,
    );
  }
  const reported = new Map<string, number>();
  for (const p of end.positions) {
    const ticker = String(p.i).toUpperCase();
    reported.set(
      ticker,
      (reported.get(ticker) ?? 0) + number(p.q, `${ticker} quantity`),
    );
  }
  for (const ticker of new Set([...actual.keys(), ...reported.keys()])) {
    if (
      Math.abs((actual.get(ticker) ?? 0) - (reported.get(ticker) ?? 0)) > 1e-7
    ) {
      throw new Error(
        `Freedom24 funding snapshot does not match live holdings for ${ticker}; retry the report`,
      );
    }
  }
  // A security transfer is not a cash deposit; corporate-action conversions do
  // not add external funding. Reject other transfers rather than invent a basis.
  for (const row of rows(report.securities_in_outs, "securities_in_outs")) {
    if (row.type !== "conversion") {
      throw new Error(
        "Freedom24 external security transfers require a verified contribution value",
      );
    }
  }
  const totalValue = number(end.account.net_assets, "closing net assets") /
    usdRate;
  const componentValue = [...end.cash, ...end.positions].reduce(
    (sum, row) =>
      sum + number(row.net_assets, "account component net assets") / usdRate,
    0,
  );
  if (Math.abs(totalValue - componentValue) > .02) {
    throw new Error(
      "Freedom24 account components do not reconcile with net assets",
    );
  }
  const netContributions = deposits - withdrawals;
  return {
    integrationId,
    currency: "USD",
    totalValue,
    netContributions,
    fundingHistory,
    fundingIncludesTransfers,
    pnl: totalValue - netContributions,
    deposits,
    withdrawals,
    cash,
    ledgerCash,
    openedAt,
    historyThrough: now,
    positionValue: totalValue - cash,
    investmentValue: totalValue - cash,
  };
}

export async function fetchFreedom24AccountPerformance(
  integration: Integration,
  positions: IntegrationPortfolioPosition[],
) {
  const credentials = parseFreedom24Credentials(integration.credentials);
  const now = new Date();
  const report = await makeTradernetApiRequest(
    credentials.apiKey,
    credentials.secretKey,
    "getBrokerReport",
    {
      date_start: "1970-01-01",
      date_end: now.toISOString().slice(0, 10),
      time_period: "23:59:59",
      format: "json",
      language: "en",
    },
  );
  return buildFreedom24AccountPerformance(
    integration.id,
    report,
    positions,
    now,
  );
}
