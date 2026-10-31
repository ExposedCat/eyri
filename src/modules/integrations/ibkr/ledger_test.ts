import { deepStrictEqual, equal, match, ok, rejects, throws } from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Database } from "@db/sqlite";
import { EventName, type IBApi } from "@stoqey/ib";
import {
  fetchIbkrAccountPerformance,
  parseIbkrFundingBatch,
} from "./ledger.ts";
import { getFlexStatementRange } from "./flex.ts";
import { readIbkrAccountSnapshot, readIbkrCashBalances } from "./adapter.ts";
import { parseIntegrationCredentials } from "../composer.ts";

const now = new Date("2026-10-22T12:00:00Z");
const date = (d: Date) => d.toISOString().slice(0, 10).replaceAll("-", "");
function statement(index = 0) {
  const range = getFlexStatementRange(index, now);
  const from = index ? "20250101" : date(range.from),
    through = date(range.to),
    at = index ? "20250103" : "20260103";
  const deposits = index ? 500 : 120, withdrawals = index ? 100 : 20;
  return `<FlexQueryResponse type="AF"><FlexStatements count="1"><FlexStatement accountId="U1" fromDate="${from}" toDate="${through}">
    <AccountInformation accountId="U1" currency="USD" dateOpened="20250101" />
    <CashTransactions>
      <CashTransaction accountId="U1" transactionID="in" currency="EUR" fxRateToBase="${
    index ? 1 : 1.2
  }" amount="${
    index ? 500 : 100
  }" type="Deposits/Withdrawals" dateTime="${at};120000" />
      <CashTransaction accountId="U1" transactionID="out" currency="USD" amount="-${withdrawals}" type="Deposits/Withdrawals" dateTime="${at};130000" />
      <CashTransaction accountId="U1" transactionID="income" currency="USD" amount="10" type="Dividends" dateTime="${at};140000" />
      <CashTransaction accountId="U1" transactionID="tax" currency="USD" amount="-2" type="Withholding Tax" dateTime="${at};140000" />
    </CashTransactions>
    <CashReport><CashReportCurrency accountId="U1" currency="BASE_SUMMARY" startingCash="${
    index ? 0 : 200
  }" endingCash="${
    index ? 200 : 300
  }" deposits="${deposits}" withdrawals="-${withdrawals}" />
    <CashReportCurrency accountId="U1" currency="USD" startingCash="${
    index ? 0 : 200
  }" endingCash="${
    index ? 200 : 300
  }" deposits="0" withdrawals="0" /></CashReport>
    <ChangeInNAV accountId="U1" startingValue="${
    index ? 0 : 500
  }" depositsWithdrawals="${deposits - withdrawals}" />
  </FlexStatement></FlexStatements></FlexQueryResponse>`;
}
function requestedStatement(range: { from: Date; to: Date }) {
  return statement(range.to.getUTCFullYear() === 2026 ? 0 : 1)
    .replace(/fromDate="\d+"/, `fromDate="${date(range.from)}"`)
    .replace(/toDate="\d+"/, `toDate="${date(range.to)}"`);
}
const integration = {
  id: 1,
  userId: 1,
  kind: "ibkr" as const,
  credentials: {
    instanceUrl: "tcp://localhost:4003",
    flexToken: "test-token",
    flexQueryId: "trades",
    fundingFlexQueryId: "funding",
  },
  createdAt: now,
  updatedAt: now,
};
const snapshot = {
  accountId: "U1",
  currency: "USD",
  totalValue: 800,
  cash: 300,
};
Deno.test("IBKR funding parses external flows with historical FX and validates independent broker totals", () => {
  const parsed = parseIbkrFundingBatch(
    statement(),
    getFlexStatementRange(0, now),
    "U1",
  );
  equal(parsed.deposits, 120);
  equal(parsed.withdrawals, 20);
  equal(parsed.fundingHistory.length, 2);
  equal(parsed.fundingHistory[0].date, "2026-01-03");
  equal(parsed.fundingHistory[0].amount, 120);
  equal(parsed.fundingHistory[1].amount, -20);
  equal(parsed.cashHistory.length, 4);
  deepStrictEqual(parsed.cashHistory[0], { date: "2026-01-03", currency: "EUR", amount: 100, type: "Deposits/Withdrawals", reference: "in" });
  equal(parsed.cashHistory[2].type, "Dividends");
  equal(parsed.cashHistory[3].amount, -2);
  equal(parsed.endingCash, 300);
  equal(parsed.openedAt, "2025-01-01T00:00:00.000Z");
  throws(
    () =>
      parseIbkrFundingBatch(
        statement().replace(
          '<ChangeInNAV accountId="U1"',
          '<ChangeInNAV assetTransfers="100" accountId="U1"',
        ),
        getFlexStatementRange(0, now),
      ),
    /transfers require verified contribution values/,
  );
  throws(
    () =>
      parseIbkrFundingBatch(
        statement().replace('type="AF"', 'type="TCF"'),
        getFlexStatementRange(0, now),
      ),
    /XML Activity Flex Query/,
  );
  throws(
    () =>
      parseIbkrFundingBatch(
        statement().replace(
          /<CashTransactions>[\s\S]*?<\/CashTransactions>/,
          "",
        ),
        getFlexStatementRange(0, now),
      ),
    /Cash Transactions/,
  );
  throws(
    () =>
      parseIbkrFundingBatch(
        statement().replace(
          'depositsWithdrawals="100"',
          'depositsWithdrawals="101"',
        ),
        getFlexStatementRange(0, now),
      ),
    /do not reconcile/,
  );
  throws(
    () =>
      parseIbkrFundingBatch(
        statement().replace('fxRateToBase="1.2"', ""),
        getFlexStatementRange(0, now),
      ),
    /FX Rate to Base/,
  );
  throws(
    () =>
      parseIbkrFundingBatch(
        statement().replace('dateOpened="20250101"', ""),
        getFlexStatementRange(0, now),
      ),
    /dateOpened/,
  );
  throws(
    () =>
      parseIbkrFundingBatch(
        statement().replace(
          'dateTime="20260103;120000"',
          'dateTime="20260230;120000"',
        ),
        getFlexStatementRange(0, now),
      ),
    /valid cash transaction/,
  );
  throws(
    () =>
      parseIbkrFundingBatch(
        statement(),
        getFlexStatementRange(0, now),
        "OTHER",
      ),
    /Gateway account/,
  );
  throws(
    () =>
      parseIbkrFundingBatch(
        statement().replace('toDate="20261021"', 'toDate="20261020"'),
        getFlexStatementRange(0, now),
      ),
    /truncated/,
  );
});
Deno.test("IBKR funding scans back to account opening, caches completed batches and excludes income from contributions", async () => {
  const db = new Database(":memory:");
  let calls = 0;
  try {
    const request = (
      _token: string,
      query: string,
      range: { from: Date; to: Date },
    ) => {
      equal(query, "funding");
      calls++;
      return Promise.resolve(
        requestedStatement(range),
      );
    };
    const result = await fetchIbkrAccountPerformance(
      db,
      integration,
      snapshot,
      request,
      now,
    );
    equal(calls, 3);
    equal(result.deposits, 620);
    equal(result.withdrawals, 120);
    equal(result.netContributions, 500);
    equal(result.fundingHistory?.reduce((sum, flow) => sum + flow.amount, 0), 500);
    equal(result.pnl, 300);
    equal(result.cash, 300);
    equal(result.historyThrough.toISOString().slice(0, 10), "2026-10-21");
    equal(
      (await fetchIbkrAccountPerformance(
        db,
        integration,
        snapshot,
        request,
        now,
      )).pnl,
      300,
    );
    equal(calls, 3);
    // Currency conversion changes the base-currency cash value without adding
    // funding. Compare the underlying cash balances instead.
    equal(
      (await fetchIbkrAccountPerformance(
        db,
        integration,
        {
          ...snapshot,
          cash: 350,
          cashByCurrency: { USD: 300 },
        },
        request,
        now,
      )).cash,
      350,
    );
    await rejects(
      fetchIbkrAccountPerformance(
        db,
        integration,
        {
          ...snapshot,
          cashByCurrency: { USD: 301 },
        },
        request,
        now,
      ),
      /today's cash activity/,
    );
    await rejects(
      fetchIbkrAccountPerformance(
        db,
        integration,
        { ...snapshot, cash: 350 },
        request,
        now,
      ),
      /today's cash activity/,
    );
    await rejects(
      fetchIbkrAccountPerformance(
        db,
        integration,
        { ...snapshot, currency: "EUR" },
        request,
        now,
      ),
      /base currency/,
    );
  } finally {
    db.close();
  }
});
Deno.test("IBKR position benchmarks can use completed funding despite live cash changes without weakening account return checks", async () => {
  const db = new Database(":memory:");
  const changed = { ...snapshot, cash: 50, cashByCurrency: { USD: 50 } };
  const request = (_token: string, _query: string, range: { from: Date; to: Date }) =>
    Promise.resolve(requestedStatement(range));
  try {
    const result = await fetchIbkrAccountPerformance(db, integration, changed, request, now, { purpose: "benchmark" });
    equal(result.deposits, 620);
    equal(result.withdrawals, 120);
    equal(result.fundingHistory?.reduce((sum, flow) => sum + flow.amount, 0), 500);
    equal(result.historyThrough.toISOString().slice(0, 10), "2026-10-21");
    await rejects(fetchIbkrAccountPerformance(db, integration, changed, request, now), /today's cash activity/);
  } finally { db.close(); }
});
Deno.test("IBKR funding uses Report Date for late-night deposits on the first statement day", () => {
  const xml = statement().replace(
    'dateTime="20260103;120000"',
    'dateTime="20251021;231306" reportDate="20251022"',
  );
  equal(
    parseIbkrFundingBatch(xml, getFlexStatementRange(0, now)).deposits,
    120,
  );
  throws(
    () =>
      parseIbkrFundingBatch(
        xml.replace('reportDate="20251022"', 'reportDate="20251021"'),
        getFlexStatementRange(0, now),
      ),
    /outside the report period/,
  );
});
Deno.test("IBKR funding stops at first funding rather than requesting empty pre-funded periods", async () => {
  const db = new Database(":memory:");
  let calls = 0;
  const xml = statement()
    .replace(
      'dateOpened="20250101"',
      'dateOpened="20250101" dateFunded="20251022"',
    )
    .replaceAll('startingCash="200"', 'startingCash="0"')
    .replace('startingValue="500"', 'startingValue="0"');
  try {
    const result = await fetchIbkrAccountPerformance(
      db,
      integration,
      snapshot,
      () => {
        calls++;
        return Promise.resolve(xml);
      },
      now,
    );
    equal(calls, 1);
    equal(result.netContributions, 100);
    equal(result.openedAt.toISOString(), "2025-01-01T00:00:00.000Z");
    throws(
      () =>
        parseIbkrFundingBatch(
          xml.replace('dateFunded="20251022"', 'dateFunded="20241231"'),
          getFlexStatementRange(0, now),
        ),
      /funding date/,
    );
    db.exec("DELETE FROM ibkr_funding_batches");
    await rejects(
      fetchIbkrAccountPerformance(
        db,
        integration,
        snapshot,
        () =>
          Promise.resolve(
            xml.replace('startingValue="0"', 'startingValue="50"'),
          ),
        now,
      ),
      /starts with assets/,
    );
  } finally {
    db.close();
  }
});
Deno.test("IBKR funding keeps the first late-night deposit and its report day in one annual batch", async () => {
  const db = new Database(":memory:");
  const periods: string[][] = [];
  const initial = statement()
    .replace(
      'dateOpened="20250101"',
      'dateOpened="20250101" dateFunded="20251021"',
    )
    .replaceAll("20260103", "20251022")
    .replaceAll('startingCash="200"', 'startingCash="0"')
    .replace('startingValue="500"', 'startingValue="0"');
  try {
    const result = await fetchIbkrAccountPerformance(
      db,
      integration,
      snapshot,
      (_t, _q, range) => {
        periods.push([date(range.from), date(range.to)]);
        let xml = initial;
        if (date(range.from) === "20261021") {
          xml = xml.replace(
            /<CashTransactions>[\s\S]*?<\/CashTransactions>/,
            "<CashTransactions />",
          )
            .replace('deposits="120"', 'deposits="0"')
            .replace('withdrawals="-20"', 'withdrawals="0"')
            .replace('depositsWithdrawals="100"', 'depositsWithdrawals="0"')
            .replaceAll('startingCash="0"', 'startingCash="300"')
            .replace('startingValue="0"', 'startingValue="800"');
        }
        return Promise.resolve(
          xml.replace(/fromDate="\d+"/, `fromDate="${date(range.from)}"`)
            .replace(/toDate="\d+"/, `toDate="${date(range.to)}"`),
        );
      },
      now,
    );
    equal(
      JSON.stringify(periods),
      JSON.stringify([
        ["20251022", "20261021"],
        ["20261021", "20261021"],
        ["20251021", "20261020"],
      ]),
    );
    equal(result.netContributions, 100);
    equal(result.pnl, 700);
  } finally {
    db.close();
  }
});
Deno.test("IBKR funding rejects history gaps, nonzero opening wealth and failed broker requests", async () => {
  for (
    const [edit, expected] of [
      [
        (s: string) => s.replaceAll('endingCash="200"', 'endingCash="201"'),
        /discontinuity/,
      ],
      [
        (s: string) => s.replace('startingValue="0"', 'startingValue="50"'),
        /starts with assets/,
      ],
    ] as const
  ) {
    const db = new Database(":memory:");
    try {
      await rejects(
        fetchIbkrAccountPerformance(
          db,
          integration,
          snapshot,
          (_t, _q, range) =>
            Promise.resolve(
              range.to.getUTCFullYear() === 2026
                ? requestedStatement(range)
                : edit(requestedStatement(range)),
            ),
          now,
        ),
        expected,
      );
    } finally {
      db.close();
    }
  }
  const db = new Database(":memory:");
  try {
    await rejects(
      fetchIbkrAccountPerformance(
        db,
        integration,
        snapshot,
        () => Promise.reject(new Error("Flex offline")),
        now,
      ),
      /Flex offline/,
    );
  } finally {
    db.close();
  }
});
class SummaryApi extends EventEmitter {
  cancelled = false;
  broken = false;
  reqAccountSummary(id: number, _group: string, tags: string) {
    equal(tags, "NetLiquidation,TotalCashValue");
    this.emit(
      EventName.accountSummary,
      id,
      "OTHER",
      "NetLiquidation",
      "9999",
      "USD",
    );
    this.emit(
      EventName.accountSummary,
      id,
      "U1",
      "NetLiquidation",
      "800",
      "USD",
    );
    this.emit(
      EventName.accountSummary,
      id,
      "U1",
      "TotalCashValue",
      this.broken ? "NaN" : "-20",
      "USD",
    );
    this.emit(EventName.accountSummaryEnd, id);
  }
  cancelAccountSummary() {
    this.cancelled = true;
  }
}
class CashApi extends EventEmitter {
  broken = false;
  subscribed = false;
  reqAccountUpdates(subscribe: boolean, account: string) {
    this.subscribed = subscribe;
    if (!subscribe) return;
    this.emit(
      EventName.updateAccountValue,
      "CashBalance",
      "9999",
      "EUR",
      "OTHER",
    );
    this.emit(
      EventName.updateAccountValue,
      "CashBalance",
      "186.91",
      "BASE",
      account,
    );
    this.emit(
      EventName.updateAccountValue,
      "CashBalance",
      this.broken ? "NaN" : "9.01",
      "USD",
      account,
    );
    this.emit(
      EventName.updateAccountValue,
      "CashBalance",
      "-2",
      "CZK",
      account,
    );
    this.emit(EventName.accountDownloadEnd, account);
  }
}
Deno.test("IBKR native cash reads the selected account and releases subscriptions on invalid data", async () => {
  const api = new CashApi();
  const result = await readIbkrCashBalances(api as unknown as IBApi, "U1", 100);
  equal(result.USD, 9.01);
  equal(result.CZK, -2);
  equal(result.BASE, undefined);
  equal(result.EUR, undefined);
  equal(api.subscribed, false);
  equal(api.listenerCount(EventName.updateAccountValue), 0);
  api.broken = true;
  await rejects(
    readIbkrCashBalances(api as unknown as IBApi, "U1", 100),
    /invalid native cash/,
  );
  equal(api.subscribed, false);
  equal(api.listenerCount(EventName.accountDownloadEnd), 0);
});
Deno.test("IBKR live summary reads selected account NAV and negative cash and releases subscriptions on errors", async () => {
  const api = new SummaryApi();
  const result = await readIbkrAccountSnapshot(
    api as unknown as IBApi,
    "U1",
    100,
  );
  equal(result.totalValue, 800);
  equal(result.cash, -20);
  ok(api.cancelled);
  equal(api.listenerCount(EventName.accountSummary), 0);
  api.broken = true;
  await rejects(
    readIbkrAccountSnapshot(api as unknown as IBApi, "U1", 100),
    /invalid TotalCashValue/,
  );
  equal(api.listenerCount(EventName.error), 0);
  const timeout = new SummaryApi();
  timeout.reqAccountSummary = () => {};
  await rejects(
    readIbkrAccountSnapshot(timeout as unknown as IBApi, "U1", 1),
    /Timed out/,
  );
  ok(timeout.cancelled);
  equal(timeout.listenerCount(EventName.accountSummaryEnd), 0);
});
Deno.test("IBKR accepts an optional dedicated funding query without changing the existing trade query", () => {
  const parsed = parseIntegrationCredentials(
    "ibkr",
    "tcp://gateway:4003 token trades funding",
  );
  equal(parsed?.flexQueryId, "trades");
  equal(parsed?.fundingFlexQueryId, "funding");
  equal(
    parseIntegrationCredentials("ibkr", "tcp://gateway:4003 token trades")
      ?.fundingFlexQueryId,
    undefined,
  );
});
