import { equal, match } from "node:assert/strict";
import type {
  IntegrationOrder,
  IntegrationPortfolioPosition,
} from "../integrations/types.ts";
import {
  buildBucketedPortfolioPositions,
  buildIntegratedAllTimePerformanceList,
  buildIntegratedPerformanceList,
  buildIntegratedSoldPerformanceList,
  getOrderTransactionKey,
} from "./portfolio.ts";

const formatTicker = (ticker: string) => ticker.toUpperCase();
function order(
  ticker: string,
  quantity: number,
  price: number,
  date: string,
  account = "test",
): IntegrationOrder {
  return {
    integrationId: 1,
    integrationKind: "ibkr",
    account,
    ticker,
    quantity,
    price,
    date: new Date(date),
    currency: "USD",
    assetCategory: "STK",
  };
}
function position(
  overrides: Partial<IntegrationPortfolioPosition> = {},
): IntegrationPortfolioPosition {
  return {
    integrationId: 1,
    integrationKind: "ibkr",
    account: "test",
    ticker: "AAPL",
    amount: 6,
    averageUnitPrice: 100,
    currentPrice: 120,
    currency: "USD",
    totalInput: 600,
    totalNow: 720,
    unrealizedPnl: 120,
    realizedPnl: 999,
    dailyPnl: null,
    dailyPnlPercentage: null,
    dailyPnlBaseline: null,
    openedAt: new Date("2025-01-01"),
    ...overrides,
  };
}

Deno.test("alltime merges partial sales and current gains with a weighted total", async () => {
  const orders = [
    order("aapl", 10, 100, "2025-01-01"),
    order("aapl", -4, 150, "2025-02-01"),
    order("MSFT", 2, 100, "2025-01-01"),
    order("MSFT", -2, 50, "2025-02-01"),
  ];
  const output = await buildIntegratedAllTimePerformanceList({
    positions: [position()],
    orders,
    formatTicker,
  });
  equal(output.match(/AAPL/g)?.length, 1);
  match(output, /^AAPL \+32\.00% \+\$320\.00/);
  match(output, /MSFT -50\.00% -\$100\.00 \(1\.0 month\)/);
  match(output, /Total: \+18\.33% \+\$220\.00/);
  // The broker's realizedPnl field must not count sales a second time.
});

Deno.test("alltime preserves perf-only and sold-only output and handles empty history", async () => {
  const positions = [position()];
  equal(
    await buildIntegratedAllTimePerformanceList({
      positions,
      orders: [],
      formatTicker,
    }),
    await buildIntegratedPerformanceList({ positions, formatTicker }),
  );
  const orders = [
    order("AAPL", 1, 100, "2025-01-01"),
    order("AAPL", -1, 150, "2025-02-01"),
  ];
  equal(
    await buildIntegratedAllTimePerformanceList({
      positions: [],
      orders,
      formatTicker,
    }),
    await buildIntegratedSoldPerformanceList({ orders, formatTicker }),
  );
  equal(
    await buildIntegratedAllTimePerformanceList({
      positions: [],
      orders: [],
      formatTicker,
    }),
    "",
  );
  equal(
    await buildIntegratedAllTimePerformanceList({
      positions: [],
      orders: [orders[0]],
      formatTicker,
    }),
    "",
  );
});

Deno.test("alltime propagates missing prices and costs to ticker and total returns", async () => {
  const orders = [
    order("AAPL", 10, 100, "2025-01-01"),
    order("AAPL", -4, 150, "2025-02-01"),
  ];
  for (
    const overrides of [{ currentPrice: null }, {
      totalInput: null,
      averageUnitPrice: null,
    }]
  ) {
    const output = await buildIntegratedAllTimePerformanceList({
      positions: [position(overrides)],
      orders,
      formatTicker,
    });
    match(output, /^AAPL \? \?/);
    match(output, /Total: \? \?/);
  }
});

Deno.test("alltime attributes sold FIFO lots to purchase buckets while consuming every sale", async () => {
  const orders = [
    order("AAPL", 4, 100, "2025-01-01"),
    order("AAPL", 6, 200, "2025-02-01"),
    order("AAPL", -5, 300, "2025-03-01"),
    // An unrelated account's sale cannot consume the remaining lots.
    order("AAPL", -5, 900, "2025-03-02", "other"),
  ];
  const livePositions = [
    position({
      amount: 5,
      totalInput: 1000,
      averageUnitPrice: 200,
      currentPrice: 250,
      totalNow: 1250,
    }),
  ];
  const transactionBuckets = new Map([[
    getOrderTransactionKey(orders[0]),
    "Core",
  ]]);
  for (
    const [bucketName, expected] of [[null, "Total: +29.17% +$350.00"], [
      "Core",
      "Total: +200.00% +$800.00",
    ]] as const
  ) {
    const positions = buildBucketedPortfolioPositions({
      orders,
      livePositions,
      transactionBuckets,
      bucketName,
    });
    const output = await buildIntegratedAllTimePerformanceList({
      positions,
      orders,
      transactionBuckets,
      bucketName,
      formatTicker,
    });
    equal(output.split("\n\n").at(-1)?.startsWith(expected), true);
  }
});
