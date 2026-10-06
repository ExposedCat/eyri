import { deepStrictEqual, equal, match, ok, rejects } from "node:assert/strict";
import { Database } from "@db/sqlite";
import {
  createIntegration,
  type Integration,
} from "../database/integration.ts";
import { ensureSchema } from "../database/setup.ts";
import { freedom24Adapter } from "./freedom24/adapter.ts";
import { ibkrAdapter } from "./ibkr/adapter.ts";
import {
  fetchIntegratedOrderHistory,
  fetchIntegratedPortfolio,
} from "./service.ts";
import type {
  IntegrationOrder,
  IntegrationPortfolioPosition,
} from "./types.ts";
import {
  buildIntegratedPerformanceList,
  buildIntegratedSoldPerformanceList,
} from "../tickers/portfolio.ts";

function position(integration: Integration): IntegrationPortfolioPosition {
  const id = integration.id;
  return {
    integrationId: id,
    integrationKind: integration.kind,
    account: `account-${id}`,
    ticker: "AAPL",
    currency: "USD",
    amount: id,
    averageUnitPrice: id * 100,
    currentPrice: id * 120,
    totalInput: id * id * 100,
    totalNow: id * id * 120,
    unrealizedPnl: id * id * 20,
    realizedPnl: id,
    dailyPnl: id * 2,
    dailyPnlBaseline: id * 118,
    dailyPnlTotalBaseline: id * (integration.kind === "f24" ? 120 : 118),
    dailyPnlPercentage: 2 / 118 * 100,
    openedAt: new Date(`2025-01-0${id}`),
  };
}

function orders(integration: Integration): IntegrationOrder[] {
  const base = {
    integrationId: integration.id,
    integrationKind: integration.kind,
    account: "same-account-label",
    ticker: "MSFT",
    currency: "USD",
    assetCategory: "STK",
  };
  // Interleaved account purchases and sales expose accidental shared FIFO lots.
  return [
    {
      ...base,
      quantity: 2,
      price: integration.id * 100,
      date: new Date(`2025-01-0${integration.id}`),
    },
    {
      ...base,
      quantity: -1,
      price: integration.id * 100 + 10,
      date: new Date(`2025-02-0${5 - integration.id}`),
    },
  ];
}

Deno.test("2 Freedom24 + 2 IBKR accounts fetch independently and aggregate holdings and history", async () => {
  const db = new Database(":memory:");
  const original = [
    freedom24Adapter.fetchPortfolio,
    ibkrAdapter.fetchPortfolio,
    freedom24Adapter.fetchOrderHistory,
    ibkrAdapter.fetchOrderHistory,
  ] as const;
  try {
    ensureSchema(db);
    db.exec("INSERT INTO users (user_id) VALUES (1), (2)");
    for (
      const [index, kind] of (["f24", "f24", "ibkr", "ibkr"] as const).entries()
    ) {
      ok(
        (await createIntegration({
          database: db,
          userId: 1,
          kind,
          credentials: { account: index + 1 },
        })).success,
      );
    }
    ok(
      (await createIntegration({
        database: db,
        userId: 2,
        kind: "f24",
        credentials: {},
      })).success,
    );
    const portfolioRequests: number[] = [];
    const historyRequests: number[] = [];
    const fetchPortfolio = (_db: Database, integration: Integration) => {
      equal(integration.credentials.account, integration.id);
      portfolioRequests.push(integration.id);
      const stock = position(integration);
      return Promise.resolve([stock, {
        ...stock,
        ticker: "AAPL",
        currency: "EUR",
      }, {
        ...stock,
        ticker: "AAPL  261218C00200000",
      }]);
    };
    const fetchHistory = (_db: Database, integration: Integration) => {
      historyRequests.push(integration.id);
      return Promise.resolve(orders(integration));
    };
    freedom24Adapter.fetchPortfolio =
      ibkrAdapter.fetchPortfolio =
        fetchPortfolio;
    freedom24Adapter.fetchOrderHistory =
      ibkrAdapter.fetchOrderHistory =
        fetchHistory;
    const [positions, history] = await Promise.all([
      fetchIntegratedPortfolio(db, 1),
      fetchIntegratedOrderHistory(db, 1),
    ]);
    deepStrictEqual(portfolioRequests, [1, 2, 3, 4]);
    deepStrictEqual(historyRequests, [1, 2, 3, 4]);
    equal(positions.length, 3);
    const merged = positions.find((item) =>
      item.ticker === "AAPL" && item.currency === "USD"
    )!;
    equal(merged.amount, 10);
    equal(merged.totalInput, 3000);
    equal(merged.totalNow, 3600);
    equal(merged.averageUnitPrice, 300);
    equal(merged.currentPrice, 360);
    equal(merged.unrealizedPnl, 600);
    equal(merged.realizedPnl, 10);
    equal(merged.dailyPnl, 20);
    equal(merged.dailyPnlBaseline, 1180);
    equal(merged.dailyPnlTotalBaseline, 1186);
    equal(merged.dailyPnlPercentage, 20 / 1180 * 100);
    equal(merged.openedAt?.toISOString(), "2025-01-01T00:00:00.000Z");
    equal(history.length, 8);
    ok(
      history.every((item, index) =>
        !index || item.date >= history[index - 1].date
      ),
    );
    const perf = await buildIntegratedPerformanceList({
      positions: [merged],
      formatTicker: (ticker) => ticker,
    });
    match(perf, /AAPL \+20\.00% \+\$600\.00/);
    const sold = await buildIntegratedSoldPerformanceList({
      orders: history,
      formatTicker: (ticker) => ticker,
    });
    match(sold, /MSFT \+4\.00% \+\$40\.00/);
  } finally {
    [
      freedom24Adapter.fetchPortfolio,
      ibkrAdapter.fetchPortfolio,
      freedom24Adapter.fetchOrderHistory,
      ibkrAdapter.fetchOrderHistory,
    ] = original;
    db.close();
  }
});

Deno.test("account failures never silently produce incomplete portfolio or history totals", async () => {
  const db = new Database(":memory:");
  const originalPortfolio = freedom24Adapter.fetchPortfolio;
  const originalHistory = freedom24Adapter.fetchOrderHistory;
  try {
    ensureSchema(db);
    db.exec("INSERT INTO users (user_id) VALUES (1)");
    for (let i = 0; i < 2; i++) {
      await createIntegration({
        database: db,
        userId: 1,
        kind: "f24",
        credentials: {},
      });
    }
    freedom24Adapter.fetchPortfolio = (_db, integration) => {
      if (integration.id === 2) return Promise.reject(new Error("Unavailable"));
      return Promise.resolve([position(integration)]);
    };
    freedom24Adapter.fetchOrderHistory = (_db, integration) => {
      if (integration.id === 2) return Promise.reject(new Error("Unavailable"));
      return Promise.resolve(orders(integration));
    };
    await rejects(
      fetchIntegratedPortfolio(db, 1),
      /f24 integration #2: Unavailable/,
    );
    await rejects(
      fetchIntegratedOrderHistory(db, 1),
      /f24 integration #2: Unavailable/,
    );
  } finally {
    freedom24Adapter.fetchPortfolio = originalPortfolio;
    freedom24Adapter.fetchOrderHistory = originalHistory;
    db.close();
  }
});
