import { deepStrictEqual, equal, throws } from "node:assert/strict";
import { Database } from "@db/sqlite";
import type { Integration } from "../../database/integration.ts";
import { cacheIbkrStockGrants, readIbkrStockGrants } from "./grants.ts";
import { ibkrAdapter } from "./adapter.ts";

const now = new Date("2026-11-03");
const integration: Integration = {
  id: 1,
  userId: 1,
  kind: "ibkr",
  credentials: {
    instanceUrl: "tcp://gateway:4003",
    flexQueryId: "trades",
    fundingFlexQueryId: "funding",
  },
  createdAt: now,
  updatedAt: now,
};
const range = { from: new Date("2026-10-01"), to: new Date("2026-11-02") };
const row = (quantity: number, day = "20261006", serial = "award") =>
  `<StockGrantActivity accountId="U1" currency="USD" symbol="IBKR" assetCategory="STK" reportDate="${day}" quantity="${quantity}" price="60" value="${
    quantity * 60
  }" serialNumber="${serial}" />`;
const statement = (rows: string) =>
  `<FlexQueryResponse type="AF"><FlexStatement accountId="U1"><StockGrantActivities>${rows}</StockGrantActivities></FlexStatement></FlexQueryResponse>`;

Deno.test("IBKR grant receipts keep dates, signed shares and zero cash cost across queries and refreshes", async () => {
  const db = new Database(":memory:");
  try {
    const xml = statement(
      row(.1) + row(.2, "20261007", "second") + row(-.05, "20261008", "return"),
    );
    cacheIbkrStockGrants(db, integration, "trades", range, xml);
    cacheIbkrStockGrants(
      db,
      integration,
      "funding",
      range,
      xml.replaceAll(/serialNumber="[^"]*"/g, ""),
    );
    cacheIbkrStockGrants(db, integration, "funding", range, xml);
    const grants = readIbkrStockGrants(db, integration);
    deepStrictEqual(
      grants.map(
        (grant) => [
          grant.ticker,
          grant.date.toISOString().slice(0, 10),
          grant.quantity,
          grant.price,
          grant.receipt,
        ],
      ),
      [
        ["IBKR", "2026-10-06", .1, 0, "gift"],
        ["IBKR", "2026-10-07", .2, 0, "gift"],
        ["IBKR", "2026-10-08", -.05, 0, "gift"],
      ],
    );
    equal(new Set(grants.map((grant) => grant.transactionKey)).size, 3);
    equal(
      (await ibkrAdapter.fetchOrderHistory(db, integration)).filter((order) =>
        order.receipt === "gift"
      ).length,
      3,
    );
    cacheIbkrStockGrants(
      db,
      integration,
      "funding",
      range,
      '<FlexQueryResponse><FlexStatement accountId="U1" /></FlexQueryResponse>',
    );
    equal(readIbkrStockGrants(db, integration).length, 3);
    throws(
      () =>
        cacheIbkrStockGrants(
          db,
          integration,
          "funding",
          range,
          statement(row(1).replace('quantity="1"', 'quantity="bad"')),
        ),
      /Grant Activity needs/,
    );
    equal(readIbkrStockGrants(db, integration).length, 3);
    throws(
      () =>
        cacheIbkrStockGrants(
          db,
          integration,
          "funding",
          range,
          statement(row(1, "20250901")),
        ),
      /outside/,
    );
    throws(
      () =>
        cacheIbkrStockGrants(
          db,
          integration,
          "funding",
          range,
          statement(row(1).replace('accountId="U1"', 'accountId="OTHER"')),
        ),
      /Grant Activity needs/,
    );
  } finally {
    db.close();
  }
});
