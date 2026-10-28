import {
  deepStrictEqual,
  equal,
  match,
  rejects,
  throws,
} from "node:assert/strict";
import { Database } from "@db/sqlite";
import type { IntegrationPortfolioPosition } from "../types.ts";
import { buildFreedom24AccountPerformance } from "./ledger.ts";
import { freedom24Adapter } from "./adapter.ts";
import { buildIntegratedAllTimePerformanceList } from "../../tickers/portfolio.ts";

const now = new Date("2026-10-22T12:00:00Z");
const positions = [{
  ticker: "XYZ",
  amount: 1,
}] as IntegrationPortfolioPosition[];
function flow(
  id: number,
  type: string,
  amount: number,
  value_usd = amount,
  extra = {},
) {
  return {
    id,
    type,
    amount,
    value_usd,
    pay_d: "2025-01-02 12:00:00",
    currency: "USD",
    approved: 1,
    reverted: 0,
    phantom: 0,
    offbalance: null,
    ...extra,
  };
}
function fixture() {
  const flows = [
    flow(1, "bank", 500),
    flow(2, "card", 100, 120, { currency: "EUR" }),
    flow(3, "bank", -100),
    flow(4, "intercompany", 40),
    flow(5, "internal_holding", -20),
    flow(6, "digital_assets", 60),
    flow(7, "dividend", 10),
    flow(8, "tax", -2),
    flow(9, "interest", 2),
  ];
  return {
    report: {
      date_start: "1970-01-01 23:59:59",
      date_end: "2026-10-22 23:59:59",
      plainAccountInfoData: {
        client_date_open: "2025-01-01",
        base_currency: "USD",
      },
      account_at_start: {
        account: {
          net_assets: 0,
          positions_from_ts: { ps: { acc: [{ curr: "USD", s: 0 }], pos: [] } },
        },
      },
      account_at_end: {
        account: {
          net_assets: 640,
          positions_from_ts: {
            ps: {
              acc: [{ curr: "USD", s: -10, net_assets: -10 }, {
                curr: "EUR",
                s: 20,
                cur_exchange_rate: 1.1,
                net_assets: 22,
              }],
              pos: [{ i: "XYZ", q: 1, net_assets: 628 }],
            },
          },
        },
      },
      cash_in_outs: flows,
      cash_flows: {
        detailed: flows.map((f) => ({ type_id: f.type, amount: f.amount })),
        total: { USD: 490, EUR: 100 },
      },
      securities_in_outs: [],
    },
  };
}
Deno.test("Freedom24 lifetime funding uses historical USD values, keeps income in P/L and current cash separate", () => {
  const account = buildFreedom24AccountPerformance(
    1,
    fixture(),
    positions,
    now,
  );
  equal(account.deposits, 720);
  equal(account.withdrawals, 120);
  equal(account.netContributions, 600);
  equal(account.fundingHistory?.length, 6);
  equal(account.fundingHistory?.reduce((sum, flow) => sum + flow.amount, 0), 600);
  equal(account.fundingIncludesTransfers, true);
  equal(account.cash, 12);
  equal(account.pnl, 40);
  equal(account.totalValue, 640);
  equal(account.positionValue, 628);
  deepStrictEqual(account.ledgerCash, { USD: -10, EUR: 20 });
});
Deno.test("Freedom24 funding rejects truncation, missing fields, unknown flows, stock transfers and mismatched holdings", () => {
  for (
    const mutate of [
      (f: any) => {
        f.report.date_start = "2025-02-01";
      },
      (f: any) => {
        f.report.date_end = "2026-10-21";
      },
      (f: any) => {
        delete f.report.cash_in_outs;
      },
      (f: any) => {
        f.report.cash_in_outs[0].value_usd = "";
      },
      (f: any) => {
        f.report.cash_in_outs[0].type = "unclassified";
      },
      (f: any) => {
        f.report.cash_in_outs[0].phantom = 1;
      },
      (f: any) => {
        f.report.account_at_start.account.net_assets = 1;
      },
      (f: any) => {
        f.report.securities_in_outs = [{ type: "transfer" }];
      },
      (f: any) => {
        f.report.account_at_end.account.positions_from_ts.ps.pos = [{
          i: "AAPL",
          q: 1,
        }];
      },
    ]
  ) {
    const f = fixture();
    mutate(f);
    throws(
      () => buildFreedom24AccountPerformance(1, f, positions, now),
      /Freedom24/,
    );
  }
});
Deno.test("Freedom24 rejects conflicting funding IDs and ignores pending or reversed entries", () => {
  const f = fixture();
  f.report.cash_in_outs.push(flow(1, "bank", 500));
  f.report.cash_flows.detailed.push({ type_id: "bank", amount: 500 });
  equal(
    buildFreedom24AccountPerformance(1, f, positions, now).netContributions,
    600,
  );
  f.report.cash_in_outs.at(-1)!.amount = 501;
  throws(
    () => buildFreedom24AccountPerformance(1, f, positions, now),
    /Conflicting/,
  );
  const pending = fixture();
  pending.report.cash_in_outs[0].approved = 0;
  pending.report.cash_in_outs[1].reverted = 1;
  pending.report.cash_flows.total = { USD: -10, EUR: 0 };
  equal(
    buildFreedom24AccountPerformance(1, pending, positions, now).deposits,
    100,
  );
});
Deno.test("Freedom24 cash balances in another base currency convert consistently to USD", () => {
  const f = fixture();
  f.report.plainAccountInfoData.base_currency = "EUR";
  f.report.account_at_end.account.net_assets = 512;
  f.report.account_at_end.account.positions_from_ts.ps.acc = [
    { curr: "USD", s: 10, cur_exchange_rate: .8, net_assets: 8 },
    { curr: "EUR", s: 8, cur_exchange_rate: 1, net_assets: 8 },
  ];
  f.report.account_at_end.account.positions_from_ts.ps.pos[0].net_assets = 496;
  const account = buildFreedom24AccountPerformance(1, f, positions, now);
  equal(account.totalValue, 640);
  equal(account.cash, 20);
  equal(account.netContributions, 600);
});
Deno.test("Freedom24 adapter requests the whole lifetime independently of historyYears and propagates failure", async () => {
  const original = globalThis.fetch;
  const integration = {
    id: 1,
    userId: 1,
    kind: "f24" as const,
    credentials: { apiKey: "key", secretKey: "secret", historyYears: .1 },
    createdAt: now,
    updatedAt: now,
  };
  const db = new Database(":memory:");
  try {
    globalThis.fetch = async (_input, init) => {
      const params = new URLSearchParams(String(init?.body));
      equal(params.get("cmd"), "getBrokerReport");
      equal(params.get("params[date_start]"), "1970-01-01");
      const f = fixture();
      f.report.date_end = `${new Date().toISOString().slice(0, 10)} 23:59:59`;
      return Response.json(f);
    };
    const account = await freedom24Adapter.fetchAccountPerformance!(
      db,
      integration,
      positions,
      [],
    );
    account.reportedComponents = [];
    const output = await buildIntegratedAllTimePerformanceList({
      positions: [],
      orders: [],
      accountPerformances: [account],
    });
    match(output, /Total: \+5\.56% \+\$40\.00/);
    globalThis.fetch = async () => {
      throw new Error("Broker offline");
    };
    await rejects(
      freedom24Adapter.fetchAccountPerformance!(db, integration, positions, []),
      /Broker offline/,
    );
  } finally {
    globalThis.fetch = original;
    db.close();
  }
});
