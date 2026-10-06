import { equal, match, ok } from "node:assert/strict";
import type {
  IntegrationOrder,
  IntegrationPortfolioPosition,
} from "../integrations/types.ts";
import {
  buildBucketedPortfolioPositions,
  buildIntegratedAllTimePerformanceList,
  buildIntegratedDailyPerformanceList,
  buildIntegratedHistory,
  buildIntegratedHistoryGroups,
  buildIntegratedPerformanceList,
  buildIntegratedSoldPerformanceList,
  buildIntegratedTickerList,
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

Deno.test("portfolio summaries retain separate currency totals and label non-USD gains", async () => {
  const positions = [
    position({ amount: 2, totalInput: 200, totalNow: 240 }),
    position({
      ticker: "EU",
      currency: "EUR",
      amount: 3,
      averageUnitPrice: 100,
      currentPrice: 110,
      totalInput: 300,
      totalNow: 330,
    }),
    position({
      ticker: "UK",
      currency: "GBP",
      amount: 1,
      averageUnitPrice: 10,
      currentPrice: 15,
      totalInput: 10,
      totalNow: 15,
    }),
    position({
      ticker: "PENCE",
      currency: "GBX",
      amount: 1,
      averageUnitPrice: 100,
      currentPrice: 110,
      totalInput: 100,
      totalNow: 110,
    }),
  ];
  const performance = await buildIntegratedPerformanceList({
    positions,
    formatTicker,
  });
  match(performance, /Total: \+20\.00% \+\$40\.00/);
  match(performance, /Total: \+10\.00% \+30\.00 EUR/);
  match(performance, /Total: \+50\.00% \+5\.00 GBP/);
  match(performance, /Total: \+10\.00% \+10\.00 GBX/);
  equal(performance.match(/Total:/g)?.length, 4);
  equal(
    await buildIntegratedAllTimePerformanceList({
      positions,
      orders: [],
      formatTicker,
    }),
    performance,
  );
  for (
    const build of [buildIntegratedTickerList, buildIntegratedPerformanceList]
  ) {
    const singleEuro = await build({ positions: [positions[1]], formatTicker });
    equal(singleEuro.includes("$"), false);
    match(singleEuro, /\+30\.00 EUR/);
  }
  const daily = await buildIntegratedDailyPerformanceList({
    positions: [{
      ...positions[1],
      dailyPnl: 3,
      dailyPnlPercentage: 1,
      dailyPnlBaseline: 300,
    }],
    formatTicker,
  });
  match(daily, /Total: \+1\.00% \+3\.00 EUR today/);
  equal(daily.includes("$"), false);
});

Deno.test("sold and history summaries separate currencies without renumbering bucket shortcuts", async () => {
  const orders = [
    order("AAPL", 1, 100, "2025-01-01"),
    { ...order("EU", 1, 10, "2025-01-02"), currency: "EUR" },
    order("AAPL", -1, 150, "2025-01-03"),
    { ...order("EU", -1, 30, "2025-01-04"), currency: "EUR" },
    { ...order("UK", 1, 50, "2025-01-05"), currency: "GBX" },
    { ...order("UK", -1, 55, "2025-01-06"), currency: "GBX" },
    order("LATER", 1, 200, "2025-01-07"),
  ];
  const sold = await buildIntegratedSoldPerformanceList({
    orders,
    formatTicker,
  });
  match(sold, /Total: \+50\.00% \+\$50\.00/);
  match(sold, /Total: \+200\.00% \+20\.00 EUR/);
  match(sold, /Total: \+10\.00% \+5\.00 GBX/);
  equal(
    await buildIntegratedAllTimePerformanceList({
      positions: [],
      orders,
      formatTicker,
    }),
    sold,
  );
  const history = buildIntegratedHistory({
    orders,
    formatLineSuffix: (_group, index) => `/move_Core_${index}`,
  });
  match(history, /Total \$300/);
  match(history, /Total 10 EUR/);
  match(history, /Total 50 GBX/);
  for (const [index, group] of buildIntegratedHistoryGroups(orders).entries()) {
    const line = history.split("\n").find((line) =>
      line.endsWith(`/move_Core_${index + 1}`)
    );
    ok(line?.includes(` ${group.ticker} `));
  }
});
