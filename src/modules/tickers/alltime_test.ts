import { deepStrictEqual, equal, match, ok, rejects } from "node:assert/strict";
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
const fxRequest: typeof fetch = async (input) => {
  const quote = String(input).split("/").at(-1)!.toUpperCase();
  return Response.json({ base: "USD", quote, rate: quote === "EUR" ? .8 : .5 });
};

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

Deno.test("portfolio summaries convert every currency to USD with one weighted total", async () => {
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
    request: fxRequest,
  });
  match(performance, /Total: \+14\.69% \+\$87\.70/);
  match(performance, /EU \+10\.00% \+\$37\.50/);
  match(performance, /UK \+50\.00% \+\$10\.00/);
  match(performance, /PENCE \+10\.00% \+\$0\.20/);
  equal(performance.match(/Total:/g)?.length, 1);
  equal(/EUR|GBP|GBX/.test(performance), false);
  equal(
    await buildIntegratedAllTimePerformanceList({
      positions,
      orders: [],
      formatTicker,
      request: fxRequest,
    }),
    performance,
  );
  for (
    const build of [buildIntegratedTickerList, buildIntegratedPerformanceList]
  ) {
    const singleEuro = await build({
      positions: [positions[1]],
      formatTicker,
      request: fxRequest,
    });
    equal(singleEuro.includes("EUR"), false);
    match(singleEuro, /\+\$37\.50/);
  }
  const daily = await buildIntegratedDailyPerformanceList({
    positions: [{
      ...positions[1],
      dailyPnl: 3,
      dailyPnlPercentage: 1,
      dailyPnlBaseline: 300,
    }],
    formatTicker,
    request: fxRequest,
  });
  match(daily, /Total: \+1\.00% \+\$3\.75 today/);
  equal(daily.includes("EUR"), false);
});

Deno.test("sold and history summaries use one USD total without renumbering bucket shortcuts", async () => {
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
    request: fxRequest,
  });
  match(sold, /Total: \+66\.17% \+\$75\.10/);
  match(sold, /EU \+200\.00% \+\$25\.00/);
  match(sold, /UK \+10\.00% \+\$0\.10/);
  equal(sold.match(/Total:/g)?.length, 1);
  equal(/EUR|GBP|GBX/.test(sold), false);
  equal(
    await buildIntegratedAllTimePerformanceList({
      positions: [],
      orders,
      formatTicker,
      request: fxRequest,
    }),
    sold,
  );
  const history = await buildIntegratedHistory({
    orders,
    request: fxRequest,
    formatLineSuffix: (_group, index) => `/move_Core_${index}`,
  });
  match(history, /Total \$314/);
  match(history, /EU 1\.0000 x \$12\.50/);
  match(history, /UK 1\.0000 x \$1\.00/);
  equal(history.match(/Total /g)?.length, 1);
  equal(/EUR|GBP|GBX/.test(history), false);
  for (const [index, group] of buildIntegratedHistoryGroups(orders).entries()) {
    const line = history.split("\n").find((line) =>
      line.endsWith(`/move_Core_${index + 1}`)
    );
    ok(line?.includes(` ${group.ticker} `));
  }
});

Deno.test("mixed-currency daily totals convert both broker baseline fields", async () => {
  const output = await buildIntegratedDailyPerformanceList({
    positions: [
      position({ dailyPnl: 2, dailyPnlPercentage: 2, dailyPnlBaseline: 100 }),
      position({
        ticker: "EU",
        currency: "EUR",
        dailyPnl: 2,
        dailyPnlPercentage: 2,
        dailyPnlBaseline: 100,
        dailyPnlTotalBaseline: 120,
      }),
      position({
        ticker: "PENCE",
        currency: "GBX",
        dailyPnl: 100,
        dailyPnlPercentage: 10,
        dailyPnlBaseline: 1000,
      }),
    ],
    formatTicker,
    request: fxRequest,
  });
  match(output, /EU \+2\.00% \+\$2\.50 today/);
  match(output, /PENCE \+10\.00% \+\$2\.00 today/);
  // USD 100 + EUR 120 * 1.25 + GBX 1000 * .02 = USD 270.
  match(output, /Total: \+2\.41% \+\$6\.50 today/);
  equal(output.match(/Total:/g)?.length, 1);
});

Deno.test("hypothetical prices are USD and monetary inputs remain unchanged", async () => {
  const positions = [position({
    ticker: "UK",
    currency: "GBX",
    amount: 2,
    currentPrice: 600,
    averageUnitPrice: 500,
    totalInput: 1000,
    totalNow: 1200,
  })];
  const original = structuredClone(positions);
  const output = await buildIntegratedTickerList({
    positions,
    priceOverrides: { UK: 15 },
    formatTicker,
    request: fxRequest,
  });
  match(output, /UK \+\$10\.00 \+50\.00%/);
  match(output, /\$10\.00 x 2\.00 \(\$15\.00 \+\$5\.00\)/);
  match(output, /\$20\.00 -> \$30\.00/);
  equal(output.includes("GBX"), false);
  deepStrictEqual(positions, original);
});

Deno.test("USD alltime and history preserve native FIFO and bucket transaction identity", async () => {
  const orders = [
    { ...order("SAME", 2, 10, "2025-01-01"), currency: "EUR" },
    { ...order("SAME", 2, 500, "2025-01-01"), currency: "GBX" },
    { ...order("SAME", -1, 20, "2025-02-01"), currency: "EUR" },
    { ...order("SAME", -1, 600, "2025-02-01"), currency: "GBX" },
  ];
  const original = structuredClone(orders);
  const eurKey = getOrderTransactionKey(orders[0]);
  const penceKey = getOrderTransactionKey(orders[1]);
  const transactionBuckets = new Map([[eurKey, "Core"]]);
  const livePositions = [
    position({
      ticker: "SAME",
      currency: "EUR",
      amount: 1,
      averageUnitPrice: 10,
      currentPrice: 20,
      totalInput: 10,
    }),
    position({
      ticker: "SAME",
      currency: "GBX",
      amount: 1,
      averageUnitPrice: 500,
      currentPrice: 600,
      totalInput: 500,
    }),
  ];
  for (
    const [bucketName, expected] of [["Core", /Total: \+100\.00% \+\$25\.00/], [
      null,
      /Total: \+20\.00% \+\$4\.00/,
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
      request: fxRequest,
    });
    match(output, expected);
    equal(output.match(/SAME/g)?.length, 1);
  }
  const keys: string[] = [];
  const history = await buildIntegratedHistory({
    orders,
    request: fxRequest,
    formatLineSuffix: (group, index) => {
      keys.push(group.transactionKey);
      return `/move_Core_${index}`;
    },
  });
  deepStrictEqual(keys, [eurKey, penceKey]);
  match(history, /\$12\.50 \(\$25\).*\/move_Core_1/);
  match(history, /\$10\.00 \(\$20\).*\/move_Core_2/);
  deepStrictEqual(orders, original);
});

Deno.test("all money reports fail on unavailable FX rather than display a partial total", async () => {
  const positions = [position(), position({ ticker: "EU", currency: "EUR" })];
  const orders = [
    { ...order("EU", 1, 10, "2025-01-01"), currency: "EUR" },
    { ...order("EU", -1, 20, "2025-02-01"), currency: "EUR" },
  ];
  const request: typeof fetch = async () => new Response(null, { status: 503 });
  for (
    const build of [
      buildIntegratedTickerList,
      buildIntegratedPerformanceList,
      buildIntegratedDailyPerformanceList,
    ]
  ) {
    await rejects(
      build({ positions, request, formatTicker }),
      /Could not load USD exchange rate for EUR/,
    );
  }
  await rejects(
    buildIntegratedSoldPerformanceList({ orders, request, formatTicker }),
    /Could not load USD exchange rate for EUR/,
  );
  await rejects(
    buildIntegratedAllTimePerformanceList({
      positions,
      orders,
      request,
      formatTicker,
    }),
    /Could not load USD exchange rate for EUR/,
  );
  await rejects(
    buildIntegratedHistory({ orders, request }),
    /Could not load USD exchange rate for EUR/,
  );
});
