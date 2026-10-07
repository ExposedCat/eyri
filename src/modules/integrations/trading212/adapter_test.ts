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
  fetchIntegratedOrderHistory,
  fetchIntegratedPortfolio,
} from "../service.ts";
import {
  buildIntegratedPerformanceList,
  buildIntegratedSoldPerformanceList,
} from "../../tickers/portfolio.ts";
import {
  toTrading212Order,
  toTrading212Position,
  trading212Adapter,
} from "./adapter.ts";
import type { Trading212HistoricalOrder } from "./api.ts";
import { fetchBucketedPositions } from "../../tickers/composer.ts";
import type { CustomContext } from "../../bot/types.ts";

function fill(
  id: number,
  side: "BUY" | "SELL" = "BUY",
): Trading212HistoricalOrder {
  return {
    order: { instrument: { ticker: "AAPL_US_EQ", currency: "USD" }, side },
    fill: {
      id,
      quantity: 0.5,
      price: side === "SELL" ? 150 : 100,
      filledAt: `2026-01-0${id}T12:00:00Z`,
      type: "TRADE",
    },
  };
}

Deno.test("Trading 212 integration maps live positions and fills, caches history and isolates accounts", async () => {
  const db = new Database(":memory:");
  const fetch = globalThis.fetch;
  const clock = Date.now;
  let now = Date.parse("2026-10-06T12:00:00Z");
  Date.now = () => now;
  const historyCalls: string[] = [];
  try {
    ensureSchema(db);
    // Exercise the previous INTEGER schema with a real epoch timestamp. The
    // driver otherwise truncates it to int32 when reading cached sync state.
    db.exec(
      "CREATE TABLE trading212_history_sync (integration_id INTEGER PRIMARY KEY, synced_at INTEGER NOT NULL)",
    );

    db.exec("INSERT INTO users (user_id) VALUES (1), (2)");
    for (const userId of [1, 2]) {
      ok(
        createIntegration({
          database: db,
          userId,
          kind: "t212",
          credentials: {
            apiKey: `account${userId}`,
            secretKey: "secret",
            // Existing environment values are ignored; calls always use live.
            environment: "demo",
          },
        }).success,
      );
    }
    globalThis.fetch = (input, init) => {
      const url = new URL(String(input));
      equal(url.origin, "https://live.trading212.com");
      const auth = new Headers(init?.headers).get("Authorization");
      if (url.pathname.endsWith("positions")) {
        return Promise.resolve(Response.json([{
          instrument: { ticker: "AAPL_US_EQ", currency: "USD" },
          quantity: 0.5,
          averagePricePaid: 100,
          currentPrice: 150,
          createdAt: "2026-01-01T12:00:00Z",
          walletImpact: {
            currency: "EUR",
            currentValue: 67,
            totalCost: 45,
            unrealizedProfitLoss: 22,
          },
        }]));
      }
      if (url.pathname.endsWith("transactions")) {
        return Promise.resolve(
          Response.json({ items: [], nextPagePath: null }),
        );
      }
      historyCalls.push(`${auth}:${url.search}`);
      now += 10_000; // Advance the test clock without waiting for API pacing.
      if (auth === `Basic ${btoa("account2:secret")}`) {
        return Promise.resolve(
          Response.json({ items: [fill(1)], nextPagePath: null }),
        );
      }
      if (url.searchParams.has("cursor")) {
        return Promise.resolve(
          Response.json({ items: [fill(1)], nextPagePath: null }),
        );
      }
      return Promise.resolve(
        Response.json({
          items: [fill(2, "SELL"), fill(1)],
          nextPagePath: "/api/v0/equity/history/orders?cursor=1&limit=50",
        }),
      );
    };
    const positions = await fetchIntegratedPortfolio(db, 1);
    equal(positions.length, 1);
    equal(positions[0].ticker, "AAPL");
    equal(positions[0].currency, "USD");
    equal(positions[0].totalInput, 50);
    equal(positions[0].totalNow, 75);
    equal(positions[0].dailyPnl, null);
    match(
      await buildIntegratedPerformanceList({
        positions,
        formatTicker: (ticker) => ticker,
      }),
      /AAPL \+50\.00% \+\$25\.00/,
    );
    const [first, second] = await Promise.all([
      fetchIntegratedOrderHistory(db, 1),
      fetchIntegratedOrderHistory(db, 1),
    ]);
    equal(historyCalls.length, 2);
    deepStrictEqual(first, second);
    deepStrictEqual(first.map((order) => order.quantity), [0.5, -0.5]);
    match(
      await buildIntegratedSoldPerformanceList({
        orders: first,
        formatTicker: (ticker) => ticker,
      }),
      /AAPL \+50\.00% \+\$25\.00/,
    );
    await fetchIntegratedOrderHistory(db, 1);
    equal(historyCalls.length, 2);
    now += 61_000;
    await fetchIntegratedOrderHistory(db, 1);
    equal(historyCalls.length, 3); // Known first page stops incremental sync.
    equal((await fetchIntegratedOrderHistory(db, 2)).length, 1);
    equal(historyCalls.length, 4);
  } finally {
    globalThis.fetch = fetch;
    Date.now = clock;
    db.close();
  }
});

Deno.test("Trading 212 interrupted history sync cannot return a partial total", async () => {
  const db = new Database(":memory:");
  const fetch = globalThis.fetch;
  const clock = Date.now;
  let now = 10_000_000;
  Date.now = () => now;
  let broken = true;
  let calls = 0;
  try {
    ensureSchema(db);
    db.exec("INSERT INTO users (user_id) VALUES (1)");
    const result = createIntegration({
      database: db,
      userId: 1,
      kind: "t212",
      credentials: { apiKey: "interrupted", secretKey: "secret" },
    });
    ok(result.success && result.data);
    const integration = result.data;
    globalThis.fetch = (input) => {
      now += 10_000;
      if (String(input).includes("transactions")) {
        return Promise.resolve(
          Response.json({ items: [], nextPagePath: null }),
        );
      }
      calls++;
      if (String(input).includes("cursor")) {
        if (broken) return Promise.resolve(new Response(null, { status: 500 }));
        return Promise.resolve(
          Response.json({ items: [fill(1)], nextPagePath: null }),
        );
      }
      return Promise.resolve(
        Response.json({
          items: [fill(2, "SELL")],
          nextPagePath: "/api/v0/equity/history/orders?cursor=2",
        }),
      );
    };
    await rejects(
      trading212Adapter.fetchOrderHistory(db, integration),
      /HTTP 500/,
    );
    equal(
      db.prepare("SELECT COUNT(*) AS n FROM trading212_history_sync").get()!.n,
      0,
    );
    broken = false;
    now += 61_000;
    equal(
      (await trading212Adapter.fetchOrderHistory(db, integration)).length,
      2,
    );
    equal(calls, 4);
  } finally {
    globalThis.fetch = fetch;
    Date.now = clock;
    db.close();
  }
});

Deno.test("Trading 212 rejects unsupported corporate actions and malformed fills; missing prices stay unknown", () => {
  const integration = { id: 1, kind: "t212" } as Integration;
  const split = fill(1);
  split.fill!.type = "STOCK_SPLIT";
  throws(
    () => toTrading212Order(integration, split),
    /unsupported corporate action/,
  );
  const invalid = fill(1);
  invalid.fill!.quantity = NaN;
  throws(
    () => toTrading212Order(integration, invalid),
    /Invalid Trading 212 execution/,
  );
  equal(toTrading212Order(integration, { order: fill(1).order }), null);
  const position = toTrading212Position(integration, {
    instrument: { ticker: "VUSA_EQ", currency: "GBP" },
    quantity: 2,
  });
  equal(position?.ticker, "VUSA_EQ");
  equal(position?.totalInput, null);
  equal(position?.totalNow, null);
});

Deno.test("portfolio commands fetch live equity and CFD cash but not equity orders until needed", async () => {
  const db = new Database(":memory:");
  const fetch = globalThis.fetch;
  const originalFetchPortfolio = trading212Adapter.fetchPortfolio;
  let requests = 0;
  try {
    ensureSchema(db);
    db.exec("INSERT INTO users (user_id) VALUES (1)");
    ok(
      createIntegration({
        database: db,
        userId: 1,
        kind: "t212",
        credentials: { apiKey: "portfolio-only", secretKey: "secret" },
      }).success,
    );
    const ctx = { db, dbEntities: { user: { userId: 1 } } } as CustomContext;
    globalThis.fetch = (input) => {
      requests++;
      if (String(input).includes("history/orders")) {
        return Promise.resolve(new Response(null, { status: 403 }));
      }
      if (String(input).includes("transactions")) {
        return Promise.resolve(
          Response.json({ items: [], nextPagePath: null }),
        );
      }
      return Promise.resolve(
        Response.json([{
          instrument: { ticker: "AAPL_US_EQ", currency: "USD" },
          quantity: 1,
          averagePricePaid: 100,
          currentPrice: 150,
        }]),
      );
    };
    equal((await fetchBucketedPositions(ctx, null)).length, 1);
    equal(requests, 2);
    // Bucket views must still load history; failure must not masquerade as a
    // complete, unbucketed total. Live holdings can be empty for this check.
    trading212Adapter.fetchPortfolio = () => Promise.resolve([]);
    db.exec(
      "INSERT INTO portfolio_buckets (user_id, name) VALUES (1, 'Savings')",
    );
    await rejects(fetchBucketedPositions(ctx, "Savings"), /HTTP 403/);
  } finally {
    trading212Adapter.fetchPortfolio = originalFetchPortfolio;
    globalThis.fetch = fetch;
    db.close();
  }
});
