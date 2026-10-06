import {
  deepStrictEqual,
  equal,
  match,
  ok,
  rejects,
  throws,
} from "node:assert/strict";
import { Database } from "@db/sqlite";
import {
  createIntegration,
  type Integration,
} from "../../database/integration.ts";
import { ensureSchema } from "../../database/setup.ts";
import {
  fetchIntegratedCfdTransfers,
  fetchIntegratedHistoryOrders,
  fetchIntegratedOrderHistory,
} from "../service.ts";
import { buildCfdHistoryOrders } from "../../tickers/cfd_history.ts";
import {
  buildIntegratedHistory,
  buildIntegratedHistoryGroups,
  filterHistoryOrdersByBucket,
} from "../../tickers/portfolio.ts";
import type { IntegrationCashTransaction } from "../types.ts";

async function buildCfdTransferHistory(
  transactions: IntegrationCashTransaction[],
  request?: typeof fetch,
) {
  return buildIntegratedHistory({
    orders: await buildCfdHistoryOrders(transactions, request),
  });
}
import {
  fetchTrading212CashHistory,
  toCashTransaction,
} from "./transactions.ts";
import type { Trading212Transaction } from "./api.ts";

function cash(
  reference: string,
  amount: number,
  type = "TRANSFER",
): Trading212Transaction {
  return {
    reference,
    amount,
    type,
    dateTime: "2026-10-06T22:06:00Z",
    currency: "USD",
  };
}

Deno.test("CFD automatically uses ordinary purchase history rows, totals, and persistent bucket shortcuts", async () => {
  const db = new Database(":memory:");
  const originalFetch = globalThis.fetch;
  const clock = Date.now;
  let now = Date.parse("2026-10-07T00:00:00Z");
  Date.now = () => now;
  try {
    ensureSchema(db);
    db.exec("INSERT INTO users (user_id) VALUES (1)");
    const result = createIntegration({
      database: db,
      userId: 1,
      kind: "t212",
      credentials: { apiKey: "normal-cfd-history", secretKey: "secret" },
    });
    ok(result.success && result.data);
    globalThis.fetch = (input) => {
      now += 20_000;
      return Promise.resolve(
        Response.json(
          String(input).includes("transactions")
            ? {
              items: [
                cash("back", 500),
                cash("out", -100),
                cash("deposit", 1000, "DEPOSIT"),
              ],
              nextPagePath: null,
            }
            : {
              items: [{
                order: {
                  instrument: { ticker: "AAPL_US_EQ", currency: "USD" },
                  side: "BUY",
                },
                fill: {
                  id: 1,
                  filledAt: "2026-01-01T12:00:00Z",
                  quantity: 1,
                  price: 100,
                  type: "TRADE",
                },
              }],
              nextPagePath: null,
            },
        ),
      );
    };
    const historyOrders = await fetchIntegratedHistoryOrders(db, 1);
    const history = await buildIntegratedHistory({
      orders: historyOrders,
      formatLineSuffix: (_group, index) => `/move_Test_${index}`,
    });
    match(
      history,
      /^2026 - \$500\n01\.01 AAPL .*\n06\.10 CFD 1\.0000 x \$400\.00 \(\$400\) \/move_Test_2\n\nTotal \$500$/,
    );
    equal((await fetchIntegratedOrderHistory(db, 1)).length, 1);
    const cfdGroup = buildIntegratedHistoryGroups(historyOrders)[1];
    const buckets = new Map([[cfdGroup.transactionKey, "Test"]]);
    match(
      await buildIntegratedHistory({
        orders: filterHistoryOrdersByBucket(historyOrders, buckets, "Test"),
      }),
      /CFD.*\n\nTotal \$400$/,
    );
    const unbucketed = await buildIntegratedHistory({
      orders: filterHistoryOrdersByBucket(historyOrders, buckets, null),
    });
    ok(!unbucketed.includes("CFD"));
    match(unbucketed, /Total \$100$/);
    const refreshed = await buildCfdHistoryOrders([
      toCashTransaction(result.data, cash("out", -100)),
      toCashTransaction(result.data, cash("back", 500)),
      toCashTransaction(result.data, {
        ...cash("later", 50),
        dateTime: "2026-10-07T22:06:00Z",
      }),
    ]);
    equal(
      buildIntegratedHistoryGroups(refreshed)[0].transactionKey,
      cfdGroup.transactionKey,
    );
    match(
      await buildIntegratedHistory({
        orders: filterHistoryOrdersByBucket(refreshed, buckets, "Test"),
      }),
      /CFD 1\.0000 x \$450\.00/,
    );
  } finally {
    globalThis.fetch = originalFetch;
    Date.now = clock;
    db.close();
  }
});

Deno.test("CFD transfer history imports full pages, nets principal, excludes deposits, and isolates accounts without extra setup", async () => {
  const db = new Database(":memory:");
  const originalFetch = globalThis.fetch;
  const clock = Date.now;
  let now = Date.parse("2026-10-07T00:00:00Z");
  Date.now = () => now;
  let calls = 0;
  try {
    ensureSchema(db);
    db.exec("INSERT INTO users (user_id) VALUES (1), (2)");
    const accounts: Integration[] = [];
    for (
      const [key, userId, kind] of [["cfd-one", 1, "t212"], [
        "cfd-two",
        2,
        "t212",
      ], ["no-cfd", 1, "f24"]] as const
    ) {
      const result = createIntegration({
        database: db,
        userId,
        kind,
        credentials: {
          apiKey: key,
          secretKey: "secret",
        },
      });
      ok(result.success && result.data);
      accounts.push(result.data);
    }
    globalThis.fetch = (input, init) => {
      calls++;
      now += 20_000;
      const url = new URL(String(input));
      equal(url.pathname, "/api/v0/equity/history/transactions");
      const auth = new Headers(init?.headers).get("Authorization");
      if (auth === `Basic ${btoa("cfd-two:secret")}`) {
        return Promise.resolve(
          Response.json({ items: [cash("back", 30)], nextPagePath: null }),
        );
      }
      equal(auth, `Basic ${btoa("cfd-one:secret")}`);
      return Promise.resolve(
        Response.json(
          url.searchParams.has("cursor")
            ? {
              items: [
                cash("out", -100),
                cash("deposit", 1000, "DEPOSIT"),
                cash("fee", -5, "FEE"),
              ],
              nextPagePath: null,
            }
            : {
              items: [cash("back", 500)],
              nextPagePath: "/api/v0/equity/history/transactions?cursor=old",
            },
        ),
      );
    };
    const [first, concurrent] = await Promise.all([
      fetchIntegratedCfdTransfers(db, 1),
      fetchIntegratedCfdTransfers(db, 1),
    ]);
    deepStrictEqual(first, concurrent);
    equal(calls, 2);
    equal(first.length, 2);
    match(
      await buildCfdTransferHistory(first),
      /CFD 1\.0000 x \$400\.00 \(\$400\)/,
    );
    await fetchIntegratedCfdTransfers(db, 1);
    equal(calls, 2);
    match(
      await buildCfdTransferHistory(await fetchIntegratedCfdTransfers(db, 2)),
      /CFD 1\.0000 x \$30\.00/,
    );
    now += 61_000;
    await fetchIntegratedCfdTransfers(db, 1);
    equal(calls, 4); // Known first page stops the incremental refresh.
    db.prepare("DELETE FROM integrations WHERE id = ?").run(accounts[0].id);
    equal(
      db.prepare(
        "SELECT COUNT(*) AS n FROM trading212_transactions WHERE integration_id = ?",
      ).get(accounts[0].id)!.n,
      0,
    );
  } finally {
    globalThis.fetch = originalFetch;
    Date.now = clock;
    db.close();
  }
});

Deno.test("CFD incomplete initial imports and refreshes never commit partial cash totals", async () => {
  const db = new Database(":memory:");
  const originalFetch = globalThis.fetch;
  const clock = Date.now;
  let now = Date.parse("2026-10-07T00:00:00Z");
  Date.now = () => now;
  let broken = true;
  let refresh = false;
  try {
    ensureSchema(db);
    db.exec("INSERT INTO users (user_id) VALUES (1)");
    const result = createIntegration({
      database: db,
      userId: 1,
      kind: "t212",
      credentials: { apiKey: "cash-interrupted", secretKey: "secret" },
    });
    ok(result.success && result.data);
    const integration = result.data;
    globalThis.fetch = (input) => {
      now += 20_000;
      if (String(input).includes("cursor")) {
        return Promise.resolve(
          broken ? new Response(null, { status: 500 }) : Response.json({
            items: [
              cash("out", -100),
              ...(refresh ? [cash("new-out", -50)] : []),
            ],
            nextPagePath: null,
          }),
        );
      }
      return Promise.resolve(
        Response.json({
          items: [cash(refresh ? "new-back" : "back", refresh ? 75 : 500)],
          nextPagePath: "/api/v0/equity/history/transactions?cursor=old",
        }),
      );
    };
    await rejects(fetchTrading212CashHistory(db, integration), /HTTP 500/);
    equal(
      db.prepare("SELECT COUNT(*) AS n FROM trading212_transactions").get()!.n,
      0,
    );
    broken = false;
    equal((await fetchTrading212CashHistory(db, integration)).length, 2);
    now += 61_000;
    broken = true;
    refresh = true;
    await rejects(fetchTrading212CashHistory(db, integration), /HTTP 500/);
    equal(
      db.prepare("SELECT COUNT(*) AS n FROM trading212_transactions").get()!.n,
      2,
    );
    broken = false;
    match(
      await buildCfdTransferHistory(
        await fetchTrading212CashHistory(db, integration),
      ),
      /CFD 1\.0000 x \$425\.00/,
    );
  } finally {
    globalThis.fetch = originalFetch;
    Date.now = clock;
    db.close();
  }
});

Deno.test("CFD cash history validates amounts and keeps outstanding funds as net transfers", async () => {
  const integration = { id: 1 } as Integration;
  throws(
    () => toCashTransaction(integration, cash("bad", NaN)),
    /Invalid Trading 212/,
  );
  throws(
    () =>
      toCashTransaction(integration, {
        ...cash("bad", 100),
        dateTime: "invalid",
      }),
    /Invalid Trading 212/,
  );
  equal(
    await buildCfdTransferHistory([
      toCashTransaction(integration, cash("deposit", 100, "DEPOSIT")),
    ]),
    "",
  );
  match(
    await buildCfdTransferHistory([
      toCashTransaction(integration, cash("out", -100)),
    ]),
    /CFD 1\.0000 x -\$100\.00/,
  );
});

Deno.test("CFD cash totals convert transaction currencies to USD and fail on missing FX", async () => {
  const integration = { id: 1 } as Integration;
  const rows = [
    toCashTransaction(integration, { ...cash("out", -100), currency: "EUR" }),
    toCashTransaction(integration, cash("back", 500)),
  ];
  match(
    await buildCfdTransferHistory(
      rows,
      () =>
        Promise.resolve(
          Response.json({ base: "USD", quote: "EUR", rate: 0.8 }),
        ),
    ),
    /CFD 1\.0000 x \$375\.00/,
  );
  await rejects(
    buildCfdTransferHistory(
      rows,
      () => Promise.resolve(new Response(null, { status: 500 })),
    ),
    /USD exchange rate for EUR/,
  );
});

Deno.test("CFD transaction pagination rejects incomplete and unrelated paths without publishing a cache", async () => {
  const db = new Database(":memory:");
  const originalFetch = globalThis.fetch;
  const clock = Date.now;
  let now = Date.parse("2026-10-07T00:00:00Z");
  Date.now = () => now;
  let nextPagePath = "";
  try {
    ensureSchema(db);
    db.exec("INSERT INTO users (user_id) VALUES (1)");
    const result = createIntegration({
      database: db,
      userId: 1,
      kind: "t212",
      credentials: {
        apiKey: "bad-cash-pages",
        secretKey: "secret",
      },
    });
    ok(result.success && result.data);
    globalThis.fetch = () => {
      now += 20_000;
      return Promise.resolve(
        Response.json({ items: [cash("back", 500)], nextPagePath }),
      );
    };
    for (
      const path of [
        "",
        "https://attacker.example/api/v0/equity/history/transactions",
        "/api/v0/equity/history/orders?cursor=1",
        "/api/v0/equity/history/transactions?limit=50",
      ]
    ) {
      nextPagePath = path;
      await rejects(
        fetchIntegratedCfdTransfers(db, 1),
        /transaction (history response|pagination)/,
      );
      equal(
        db.prepare("SELECT COUNT(*) AS n FROM trading212_transactions").get()!
          .n,
        0,
      );
    }
    globalThis.fetch = () => {
      now += 20_000;
      return Promise.resolve(new Response(null, { status: 403 }));
    };
    await rejects(
      fetchIntegratedCfdTransfers(db, 1),
      /t212 integration #1: .*HTTP 403/,
    );
  } finally {
    globalThis.fetch = originalFetch;
    Date.now = clock;
    db.close();
  }
});
