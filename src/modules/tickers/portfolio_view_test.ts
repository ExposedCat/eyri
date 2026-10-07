import { deepStrictEqual, equal, match, ok, rejects } from "node:assert/strict";
import { Database } from "@db/sqlite";
import { ensureSchema } from "../database/setup.ts";
import { createIntegration } from "../database/integration.ts";
import {
  createBucket,
  moveTransactionToBucket,
  setBucketIncluded,
  transferBucketAccess,
} from "../database/bucket.ts";
import type {
  IntegrationOrder,
  IntegrationPortfolioPosition,
} from "../integrations/types.ts";
import {
  buildIntegratedAllTimePerformanceList,
  buildIntegratedSoldPerformances,
  getOrderTransactionKey,
} from "./portfolio.ts";
import { buildAllTimeSeries, instrumentKey } from "./alltime_chart.ts";
import {
  fetchPortfolioView,
  hasPortfolioViewIntegrations,
} from "./portfolio_view.ts";

function order(
  owner: number,
  quantity: number,
  price: number,
  date: string,
): IntegrationOrder {
  return {
    integrationId: owner,
    integrationKind: "ibkr",
    account: String(owner),
    ticker: "AAPL",
    date: new Date(date),
    quantity,
    price,
    currency: "USD",
    assetCategory: "STK",
  };
}
function position(owner: number, amount: number): IntegrationPortfolioPosition {
  return {
    integrationId: owner,
    integrationKind: "ibkr",
    account: String(owner),
    ticker: "AAPL",
    amount,
    averageUnitPrice: 100,
    currentPrice: 200,
    currency: "USD",
    totalInput: amount * 100,
    totalNow: amount * 200,
    unrealizedPnl: amount * 100,
    realizedPnl: 0,
    dailyPnl: amount * 5,
    dailyPnlBaseline: amount * 195,
    dailyPnlPercentage: 5 / 195 * 100,
    openedAt: new Date("2025-01-01"),
  };
}

Deno.test("included buckets merge holdings and sales using owner integrations and independent FIFO", async () => {
  const db = new Database(":memory:");
  try {
    ensureSchema(db);
    db.exec("INSERT INTO users (user_id) VALUES (1), (2), (3)");
    for (const userId of [1, 2]) {
      createIntegration({
        database: db,
        userId,
        kind: "ibkr",
        credentials: {},
      });
    }
    await createBucket({ database: db, userId: 1, name: "Shared" });
    const ownerOrders = [
      order(1, 2, 50, "2025-01-01"),
      order(1, 4, 100, "2025-01-02"),
      order(1, -3, 150, "2025-01-03"),
    ];
    const recipientOrders = [order(2, 1, 100, "2025-01-02")];
    await moveTransactionToBucket({
      database: db,
      userId: 1,
      bucketName: "Shared",
      transactionKey: getOrderTransactionKey(ownerOrders[1]),
    });
    ok(
      transferBucketAccess({
        database: db,
        userId: 1,
        name: "Shared",
        recipientId: 2,
      }).success,
    );
    ok(
      transferBucketAccess({
        database: db,
        userId: 1,
        name: "Shared",
        recipientId: 3,
      }).success,
    );
    const calls: string[] = [];
    const runtime = {
      portfolio: (_db: Database, id: number) => {
        calls.push(`portfolio:${id}`);
        return Promise.resolve(
          id === 1 ? [position(1, 3)] : id === 2 ? [position(2, 1)] : [],
        );
      },
      orders: (_db: Database, id: number) => {
        calls.push(`orders:${id}`);
        return Promise.resolve(
          id === 1 ? ownerOrders : id === 2 ? recipientOrders : [],
        );
      },
      history: (_db: Database, id: number) =>
        Promise.resolve(id === 1 ? ownerOrders : recipientOrders),
    };
    const before = await fetchPortfolioView(db, 2, null, {}, runtime);
    equal(before.positions[0].amount, 1);
    equal(calls.includes("portfolio:1"), false);
    calls.length = 0;
    const shared = await fetchPortfolioView(
      db,
      3,
      "Shared",
      { history: true },
      runtime,
    );
    deepStrictEqual(calls.sort(), ["orders:1", "portfolio:1"]);
    equal(shared.positions[0].amount, 3);
    equal(shared.positions[0].totalInput, 300);
    equal(hasPortfolioViewIntegrations(db, 3, "Shared"), true);
    equal(hasPortfolioViewIntegrations(db, 3), false);
    await rejects(
      () => fetchPortfolioView(db, 3, "Private", {}, runtime),
      /Bucket not found/,
    );
    setBucketIncluded({
      database: db,
      userId: 2,
      name: "Shared",
      included: true,
    });
    setBucketIncluded({
      database: db,
      userId: 2,
      name: "Shared",
      included: true,
    });
    const merged = await fetchPortfolioView(
      db,
      2,
      null,
      { history: true },
      runtime,
    );
    equal(merged.positions.length, 1);
    equal(merged.positions[0].amount, 4);
    equal(merged.positions[0].totalInput, 400);
    equal(merged.positions[0].dailyPnl, 20);
    equal(merged.historyOrders.length, 2);
    equal(new Set(merged.historyOrders.map(getOrderTransactionKey)).size, 2);
    const sold = buildIntegratedSoldPerformances(
      merged.orders,
      merged.transactionBuckets,
      merged.bucketName,
    );
    equal(sold.length, 1);
    equal(sold[0].realizedPnl, 50);
    equal(sold[0].cost, 100);
    match(
      await buildIntegratedAllTimePerformanceList({
        ...merged,
        formatTicker: (s) => s,
      }),
      /Total: \+90\.00% \+\$450\.00/,
    );
    const series = buildAllTimeSeries(
      { ...merged, now: new Date("2025-01-03") },
      new Map([[instrumentKey(merged.positions[0]), {
        symbol: "AAPL",
        currency: "USD",
        splits: [],
        bars: [{ date: "2025-01-01", close: 50 }, {
          date: "2025-01-02",
          close: 100,
        }, { date: "2025-01-03", close: 200 }],
      }]]),
      new Map([["USD", 1]]),
    );
    equal(series.at(-1)?.gain, 450);
    equal(series.at(-1)?.percentage, 90);
    setBucketIncluded({
      database: db,
      userId: 1,
      name: "Shared",
      included: true,
    });
    const owner = await fetchPortfolioView(
      db,
      1,
      null,
      { history: true },
      runtime,
    );
    equal(owner.positions[0].amount, 3);
    equal(
      buildIntegratedSoldPerformances(
        owner.orders,
        owner.transactionBuckets,
        owner.bucketName,
      )[0].realizedPnl,
      250,
    );
    setBucketIncluded({
      database: db,
      userId: 2,
      name: "Shared",
      included: false,
    });
    equal(
      (await fetchPortfolioView(db, 2, null, {}, runtime)).positions[0].amount,
      1,
    );
    setBucketIncluded({
      database: db,
      userId: 3,
      name: "Shared",
      included: true,
    });
    equal(hasPortfolioViewIntegrations(db, 3), true);
    equal(
      (await fetchPortfolioView(db, 3, null, {}, runtime)).positions[0].amount,
      3,
    );
    await rejects(
      () =>
        fetchPortfolioView(db, 2, null, {}, {
          ...runtime,
          portfolio: () => Promise.reject(new Error("Gateway unavailable")),
        }),
      /Gateway unavailable/,
    );
  } finally {
    db.close();
  }
});
