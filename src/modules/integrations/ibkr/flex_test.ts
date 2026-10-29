import { deepStrictEqual, equal } from "node:assert/strict";
import { ensureFlexCommissions, getFlexStatement, getFlexStatementRange, readFlexOrders } from "./flex.ts";
import { Database } from "@db/sqlite";

Deno.test("legacy Flex fills backfill execution fees without changing bucket identity or double counting fills", async () => {
  const db = new Database(":memory:");
  const integration = { id: 1, userId: 1, kind: "ibkr" as const,
    credentials: { instanceUrl: "tcp://localhost:4001", flexToken: "token", flexQueryId: "trades" }, createdAt: new Date(), updatedAt: new Date() };
  try {
    readFlexOrders(db, integration);
    db.prepare("INSERT INTO ibkr_flex_trades(integration_id,query_id,trade_key,ticker,date,quantity,price,currency,asset_category,synced_at) VALUES(1,'trades','legacy','A','2025-01-01',2,10,'EUR','STK','2025-01-02')").run();
    let calls = 0;
    await ensureFlexCommissions(db, integration, async () => { calls++; return '<FlexQueryResponse><Trade symbol="A" tradeDate="20250101" quantity="2" buySell="BUY" tradePrice="10" currency="EUR" assetCategory="STK" ibCommission="-1" ibCommissionCurrency="USD" /></FlexQueryResponse>'; });
    const orders = readFlexOrders(db, integration);
    equal(orders.length, 1);
    equal(orders[0].price, 10);
    deepStrictEqual(orders[0].commission, { amount: -1, currency: "USD" });
    await ensureFlexCommissions(db, integration, async () => { calls++; throw new Error("Unexpected request"); });
    equal(calls, 1);
  } finally { db.close(); }
});

Deno.test("missing commission fields remain unknown, without breaking existing position reports or repeatedly downloading", async () => {
  const db = new Database(":memory:");
  const integration = { id: 1, userId: 1, kind: "ibkr" as const,
    credentials: { instanceUrl: "tcp://localhost:4001", flexToken: "token", flexQueryId: "trades" }, createdAt: new Date(), updatedAt: new Date() };
  try {
    readFlexOrders(db, integration);
    db.prepare("INSERT INTO ibkr_flex_trades(integration_id,query_id,trade_key,ticker,date,quantity,price,currency,asset_category,synced_at) VALUES(1,'trades','legacy','A','2025-01-01',2,10,'USD','STK','2025-01-02')").run();
    let calls = 0;
    const query = async () => { calls++; return '<FlexQueryResponse><Trade symbol="A" tradeDate="20250101" quantity="2" buySell="BUY" tradePrice="10" currency="USD" /></FlexQueryResponse>'; };
    await ensureFlexCommissions(db, integration, query);
    await ensureFlexCommissions(db, integration, query);
    equal(calls, 1);
    equal(readFlexOrders(db, integration)[0].commission, undefined);
  } finally { db.close(); }
});

function getRangeDates(batchIndex: number, now: string) {
  const range = getFlexStatementRange(batchIndex, new Date(now));
  return [range.from, range.to].map((date) => date.toISOString().slice(0, 10));
}

Deno.test("IBKR Flex batches end on the last completed UTC day without gaps", () => {
  deepStrictEqual(getRangeDates(0, "2026-10-08T12:00:00Z"), [
    "2025-10-08",
    "2026-10-07",
  ]);
  deepStrictEqual(getRangeDates(1, "2026-10-08T12:00:00Z"), [
    "2024-10-08",
    "2025-10-07",
  ]);
  deepStrictEqual(getRangeDates(0, "2026-10-08T23:30:00-04:00"), [
    "2025-10-09",
    "2026-10-08",
  ]);
});

Deno.test("IBKR Flex keeps polling the same report while generation is in progress", async () => {
  const report =
    '<FlexQueryResponse><FlexStatements count="1"><FlexStatement><Trades><Trade symbol="VY8GTE" tradeDate="20261006" quantity="49" /></Trades></FlexStatement></FlexStatements></FlexQueryResponse>';
  const responses = [
    "<FlexStatementResponse><Status>Success</Status><ReferenceCode>reference</ReferenceCode></FlexStatementResponse>",
    "<FlexStatementResponse><Status>Warn</Status><ErrorCode>1019</ErrorCode><ErrorMessage>Statement generation in progress. Please try again shortly.</ErrorMessage></FlexStatementResponse>",
    report,
  ];
  const urls: URL[] = [];
  const sleeps: number[] = [];
  let time = 0;

  const statement = await getFlexStatement(
    "token",
    "query",
    getFlexStatementRange(0, new Date("2026-10-08T12:00:00Z")),
    (input) => {
      urls.push(new URL(String(input)));
      return Promise.resolve(new Response(responses.shift()));
    },
    (milliseconds) => {
      sleeps.push(milliseconds);
      time += milliseconds;
      return Promise.resolve();
    },
    () => time,
  );

  equal(statement, report);
  deepStrictEqual(
    urls.map((url) => [
      url.pathname.split("/").at(-1),
      url.searchParams.get("q"),
      url.searchParams.get("fd"),
      url.searchParams.get("td"),
    ]),
    [
      ["SendRequest", "query", "20251008", "20261007"],
      ["GetStatement", "reference", null, null],
      ["GetStatement", "reference", null, null],
    ],
  );
  deepStrictEqual(sleeps, [6_100, 3_000, 3_100]);
});

Deno.test("IBKR Flex shares request pacing across concurrent queries with the same token", async () => {
  let time = 0;
  const starts: number[] = [];
  const request: typeof fetch = (input) => {
    starts.push(time);
    return Promise.resolve(
      new Response(
        String(input).includes("SendRequest")
          ? "<FlexStatementResponse><Status>Success</Status><ReferenceCode>reference</ReferenceCode></FlexStatementResponse>"
          : '<FlexQueryResponse type="AF" />',
      ),
    );
  };
  const sleep = (milliseconds: number) => {
    time += milliseconds;
    return Promise.resolve();
  };
  const range = getFlexStatementRange(0);
  await Promise.all([
    getFlexStatement("shared", "trades", range, request, sleep, () => time),
    getFlexStatement("shared", "funding", range, request, sleep, () => time),
  ]);
  equal(starts.length, 4);
  for (let index = 1; index < starts.length; index++) {
    equal(starts[index] - starts[index - 1] >= 6_100, true);
  }
});
