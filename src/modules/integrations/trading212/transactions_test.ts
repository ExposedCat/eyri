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
  fetchIntegratedPortfolio,
  mergePositions,
} from "../service.ts";
import {
  buildCfdHistoryOrders,
  buildCfdPositions,
} from "../../tickers/cfd_history.ts";
import {
  buildBucketedPortfolioPositions,
  buildIntegratedAllTimePerformanceList,
  buildIntegratedHistory,
  buildIntegratedPerformanceList,
  buildIntegratedSoldPerformanceList,
  buildIntegratedSoldPerformances,
  buildIntegratedTickerList,
} from "../../tickers/portfolio.ts";
import { buildPortfolioChart } from "../../tickers/portfolio_chart.ts";
import { fetchPortfolioView } from "../../tickers/portfolio_view.ts";
import {
  buildAllTimeSeries,
  loadAllTimeDataset,
} from "../../tickers/alltime_chart.ts";
import {
  createBucket,
  moveTransactionToBucket,
  readBucketAssignments,
  setBucketIncluded,
  transferBucketAccess,
} from "../../database/bucket.ts";
import type { IntegrationCashTransaction } from "../types.ts";

async function buildCfdTransferPerformance(
  transactions: IntegrationCashTransaction[],
  request?: typeof fetch,
) {
  return buildIntegratedSoldPerformanceList({
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

Deno.test("CFD purchases, full sales and open funding flow through every portfolio view and shared bucket", async () => {
  const db = new Database(":memory:");
  const originalFetch = globalThis.fetch;
  const clock = Date.now;
  let now = Date.parse("2026-10-07T00:00:00Z");
  Date.now = () => now;
  const transactions = [
    { ...cash("out", -500), dateTime: "2026-01-01T12:00:00Z" },
    { ...cash("back", 1000), dateTime: "2026-01-03T12:00:00Z" },
    { ...cash("open", -200), dateTime: "2026-01-04T12:00:00Z" },
    cash("deposit", 5000, "DEPOSIT"),
  ];
  let cashCalls = 0;
  try {
    ensureSchema(db);
    db.exec("INSERT INTO users (user_id) VALUES (1), (2)");
    const result = createIntegration({
      database: db,
      userId: 1,
      kind: "t212",
      credentials: { apiKey: "normal-cfd-history", secretKey: "secret" },
    });
    ok(result.data);
    await createBucket({ database: db, userId: 1, name: "Test" });
    // The old net-return row must migrate without losing its bucket.
    await moveTransactionToBucket({
      database: db,
      userId: 1,
      bucketName: "Test",
      transactionKey: `t212:CFD:${result.data.id}`,
    });
    globalThis.fetch = (input) => {
      now += 20_000;
      const url = new URL(String(input));
      equal(url.origin, "https://live.trading212.com");
      if (url.pathname.endsWith("positions")) {
        return Promise.resolve(Response.json([]));
      }
      if (url.pathname.endsWith("transactions")) {
        cashCalls++;
        return Promise.resolve(
          Response.json({ items: transactions, nextPagePath: null }),
        );
      }
      equal(url.pathname, "/api/v0/equity/history/orders");
      return Promise.resolve(Response.json({ items: [], nextPagePath: null }));
    };
    const [orders, positions] = await Promise.all([
      fetchIntegratedOrderHistory(db, 1),
      fetchIntegratedPortfolio(db, 1),
    ]);
    equal(cashCalls, 1);
    deepStrictEqual(orders.map((o) => [o.quantity, o.price]), [[1, 500], [
      -1,
      1000,
    ], [1, 200]]);
    deepStrictEqual(await fetchIntegratedHistoryOrders(db, 1), orders);
    equal(positions.length, 1);
    equal(positions[0].ticker, "CFD");
    equal(positions[0].totalInput, 200);
    equal(positions[0].totalNow, 200);
    const assignments = readBucketAssignments(db, 1);
    equal(assignments.size, 2);
    for (const o of orders.filter((o) => o.quantity > 0)) {
      equal(assignments.get(o.transactionKey!), "Test");
    }
    const history = await buildIntegratedHistory({
      orders,
      formatLineSuffix: (_group, index) => `/move_Test_${index}`,
    });
    match(history, /01\.01 CFD 1\.0000 x \$500\.00 \(\$500\) \/move_Test_1/);
    match(history, /04\.01 CFD 1\.0000 x \$200\.00 \(\$200\) \/move_Test_2/);
    match(history, /Total \$700$/);
    match(
      await buildIntegratedSoldPerformanceList({ orders }),
      /CFD \+100\.00% \+\$500\.00/,
    );
    match(
      await buildIntegratedAllTimePerformanceList({ orders, positions }),
      /CFD \+71\.43% \+\$500\.00/,
    );
    match(
      await buildIntegratedAllTimePerformanceList({
        orders,
        positions,
        numberOnly: true,
      }),
      /\+\$500\.00$/,
    );
    match(
      await buildIntegratedTickerList({ positions }),
      /\$200\.00 -> \$200\.00/,
    );
    match(
      await buildIntegratedPerformanceList({
        positions,
        showCurrentValue: true,
      }),
      /CFD 0\.00% \$200\.00/,
    );
    equal((await buildPortfolioChart(positions))?.holdings[0].ticker, "CFD");
    const bucketView = await fetchPortfolioView(db, 1, "Test", {
      history: true,
    });
    equal(bucketView.positions[0].totalNow, 200);
    equal(
      buildIntegratedSoldPerformances(
        bucketView.orders,
        bucketView.transactionBuckets,
        "Test",
      )[0].realizedPnl,
      500,
    );
    const unbucketed = await fetchPortfolioView(db, 1, null, { history: true });
    equal(unbucketed.positions.length, 0);
    equal(
      buildIntegratedSoldPerformances(
        unbucketed.orders,
        unbucketed.transactionBuckets,
      ).length,
      0,
    );
    ok(
      transferBucketAccess({
        database: db,
        userId: 1,
        name: "Test",
        recipientId: 2,
      }).success,
    );
    ok(
      setBucketIncluded({
        database: db,
        userId: 2,
        name: "Test",
        included: true,
      }).success,
    );
    const shared = await fetchPortfolioView(db, 2, null, { history: true });
    equal(shared.positions[0].totalInput, 200);
    equal(
      buildIntegratedSoldPerformances(
        shared.orders,
        shared.transactionBuckets,
      )[0].realizedPnl,
      500,
    );
    const noMarket = {
      resolve: () => {
        throw new Error("CFD must never resolve a market symbol");
      },
      get: () => {
        throw new Error("CFD must never fetch market prices");
      },
    };
    const dataset = await loadAllTimeDataset(
      db,
      { ...shared, now: new Date("2026-01-05") },
      2,
      "CFD",
      noMarket as never,
    );
    equal(dataset.points.find((p) => p.date === "2026-01-02")!.gain, 0);
    equal(dataset.points.find((p) => p.date === "2026-01-03")!.gain, 500);
    equal(dataset.points.at(-1)!.gain, 500);
    equal(dataset.points.at(-1)!.percentage, 500 / 700 * 100);
    const refresh = await buildCfdHistoryOrders(
      transactions.map((t) => toCashTransaction(result.data!, t)).concat(
        toCashTransaction(result.data, {
          ...cash("later", 250),
          dateTime: "2026-01-06T12:00:00Z",
        }),
      ),
    );
    equal(refresh[0].transactionKey, orders[0].transactionKey);
    equal(refresh[2].transactionKey, orders[2].transactionKey);
    equal(buildCfdPositions(refresh).length, 0);
    equal(buildIntegratedSoldPerformances(refresh)[0].realizedPnl, 550);
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
      await buildCfdTransferPerformance(first),
      /CFD \+400\.00% \+\$400\.00/,
    );
    await fetchIntegratedCfdTransfers(db, 1);
    equal(calls, 2);
    match(
      await buildCfdTransferPerformance(
        await fetchIntegratedCfdTransfers(db, 2),
      ),
      /CFD 0\.00% \+\$30\.00/,
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
      await buildCfdTransferPerformance(
        await fetchTrading212CashHistory(db, integration),
      ),
      /CFD .*\+\$425\.00/,
    );
  } finally {
    globalThis.fetch = originalFetch;
    Date.now = clock;
    db.close();
  }
});

Deno.test("CFD cash history validates amounts and outstanding funding is an ordinary purchase", async () => {
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
    await buildCfdTransferPerformance([
      toCashTransaction(integration, cash("deposit", 100, "DEPOSIT")),
    ]),
    "",
  );
  match(
    await buildIntegratedHistory({
      orders: await buildCfdHistoryOrders([
        toCashTransaction(integration, cash("out", -100)),
      ]),
    }),
    /CFD 1\.0000 x \$100\.00/,
  );
});

Deno.test("CFD cash totals convert transaction currencies to USD and fail on missing FX", async () => {
  const integration = { id: 1 } as Integration;
  const rows = [
    toCashTransaction(integration, { ...cash("out", -100), currency: "EUR" }),
    toCashTransaction(integration, cash("back", 500)),
  ];
  match(
    await buildCfdTransferPerformance(
      rows,
      () =>
        Promise.resolve(
          Response.json({ base: "USD", quote: "EUR", rate: 0.8 }),
        ),
    ),
    /CFD \+300\.00% \+\$375\.00/,
  );
  await rejects(
    buildCfdTransferPerformance(
      rows,
      () => Promise.resolve(new Response(null, { status: 500 })),
    ),
    /USD exchange rate for EUR/,
  );
});

Deno.test("each CFD return sells all funding in its own account, including losses and additional proceeds", async () => {
  const rows = [
    { ...cash("one", -500), dateTime: "2026-01-01T12:00:00Z" },
    { ...cash("two", -100), dateTime: "2026-01-02T12:00:00Z" },
    { ...cash("partial", 200), dateTime: "2026-01-03T12:00:00Z" },
    { ...cash("extra", 50), dateTime: "2026-01-04T12:00:00Z" },
  ];
  const first = { id: 1 } as Integration;
  const second = { id: 2 } as Integration;
  const orders = await buildCfdHistoryOrders([
    ...rows.map((row) => toCashTransaction(first, row)),
    toCashTransaction(second, rows[0]),
  ].reverse());
  equal(
    orders.find((o) => o.transactionKey === "t212:CFD:1:partial:sale")!
      .quantity,
    -2,
  );
  const sold = buildIntegratedSoldPerformances(orders)[0];
  equal(sold.cost, 600);
  equal(sold.proceeds, 250);
  equal(sold.realizedPnl, -350);
  const positions = buildCfdPositions(orders);
  equal(positions.length, 1);
  equal(positions[0].integrationId, 2);
  equal(positions[0].totalInput, 500);
  equal(positions[0].totalNow, 500);
});

Deno.test("CFD buckets value each outstanding purchase at its own cost across accounts and funding amounts", async () => {
  const first = { id: 1 } as Integration;
  const second = { id: 2 } as Integration;
  const orders = await buildCfdHistoryOrders([
    toCashTransaction(first, {
      ...cash("one", -500),
      dateTime: "2026-01-01T12:00:00Z",
    }),
    toCashTransaction(first, {
      ...cash("two", -100),
      dateTime: "2026-01-02T12:00:00Z",
    }),
    toCashTransaction(second, {
      ...cash("other", -200),
      dateTime: "2026-01-02T12:00:00Z",
    }),
  ]);
  const transactionBuckets = new Map([[orders[0].transactionKey!, "Test"]]);
  const livePositions = mergePositions(buildCfdPositions(orders));
  const selected = buildBucketedPortfolioPositions({
    orders,
    livePositions,
    transactionBuckets,
    bucketName: "Test",
  });
  equal(selected[0].amount, 1);
  equal(selected[0].totalInput, 500);
  equal(selected[0].totalNow, 500);
  equal(selected[0].unrealizedPnl, 0);
  const rest = buildBucketedPortfolioPositions({
    orders,
    livePositions,
    transactionBuckets,
    bucketName: null,
  });
  equal(rest[0].amount, 2);
  equal(rest[0].totalInput, 300);
  equal(rest[0].totalNow, 300);
  equal(rest[0].currentPrice, 150);
  const points = buildAllTimeSeries(
    {
      orders,
      positions: selected,
      transactionBuckets,
      bucketName: "Test",
      now: new Date("2026-01-03"),
    },
    new Map(),
    new Map([["USD", 1]]),
  );
  ok(points.every((p) => p.gain === 0 && p.percentage === 0));
});

Deno.test("CFD cash permission failures reject both portfolio and performance instead of returning partial equity data", async () => {
  const db = new Database(":memory:");
  const original = globalThis.fetch;
  try {
    ensureSchema(db);
    db.exec("INSERT INTO users (user_id) VALUES (1)");
    createIntegration({
      database: db,
      userId: 1,
      kind: "t212",
      credentials: { apiKey: "cfd-permission-failure", secretKey: "secret" },
    });
    globalThis.fetch = (input) =>
      Promise.resolve(
        String(input).includes("transactions")
          ? new Response(null, { status: 403 })
          : Response.json(
            String(input).includes("positions")
              ? []
              : { items: [], nextPagePath: null },
          ),
      );
    const [portfolio, history] = await Promise.allSettled([
      fetchIntegratedPortfolio(db, 1),
      fetchIntegratedOrderHistory(db, 1),
    ]);
    equal(portfolio.status, "rejected");
    equal(history.status, "rejected");
    if (portfolio.status === "rejected") {
      match(portfolio.reason.message, /HTTP 403/);
    }
    if (history.status === "rejected") {
      match(history.reason.message, /HTTP 403/);
    }
  } finally {
    globalThis.fetch = original;
    db.close();
  }
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
