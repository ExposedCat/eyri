import { deepStrictEqual, equal, ok, throws } from "node:assert/strict";
import type {
  IntegrationOrder,
  IntegrationPortfolioPosition,
} from "../integrations/types.ts";
import type { PriceHistory } from "../market_data/history.ts";
import { buildChartGifts, withChartGifts } from "./chart_gifts.ts";
import { buildChartBenchmark } from "./chart_benchmark.ts";
import { benchmarkForKind } from "./benchmark_capital.ts";

const receipt = (date: string, quantity = 1): IntegrationOrder => ({
  integrationId: 1,
  integrationKind: "ibkr",
  account: "A",
  ticker: "IBKR",
  currency: "USD",
  assetCategory: "STK",
  date: new Date(date),
  quantity,
  price: 0,
  receipt: "gift",
});
const history: PriceHistory = {
  symbol: "IBKR",
  currency: "USD",
  instrumentType: "EQUITY",
  splits: [],
  bars: [
    { date: "2025-01-01", close: 10 },
    { date: "2025-01-02", close: 20 },
    { date: "2025-01-03", close: 30 },
  ],
};
const histories = new Map([[JSON.stringify(["IBKR", "USD"]), history]]);
const rates = new Map([["USD", 1]]);

Deno.test("both portfolios receive the same gift shares without buying index shares or increasing deposits", () => {
  const index = buildChartBenchmark(
    { ...history, symbol: "CSPX.L", instrumentType: "ETF" },
    [{ date: "2025-01-01", amountUsd: 100 }],
    "2025-01-01",
    "2025-01-03",
  );
  const gifts = buildChartGifts(
    [receipt("2025-01-02", .5)],
    histories,
    new Map(),
    [],
    rates,
    "2025-01-01",
    "2025-01-03",
  );
  deepStrictEqual(gifts.map((point) => point.valueUsd), [0, 10, 15]);
  const comparison = withChartGifts(index, gifts);
  equal(comparison.points[0].gain, index.points[0].gain);
  equal(comparison.points[1].gain - index.points[1].gain, 10);
  equal(comparison.points[2].gain - index.points[2].gain, 15);
  equal(comparison.points[2].depositsUsd, 100);
  equal(comparison.points[2].openCostUsd, index.points[2].openCostUsd);
  equal(comparison.points[2].percentage, 215);
  equal(benchmarkForKind(comparison, "perf").points[2].gain, 215);
  equal(benchmarkForKind(comparison, "worth").points[2].gain, 315);
  equal(index.points[2].gain, 200);
});

Deno.test("gift shares follow splits and returns, retain their value when clipped, and use the live endpoint mark", () => {
  const splitHistory = {
    ...history,
    splits: [{ date: "2025-01-02", ratio: 2 }],
    bars: history.bars.map((bar) => ({
      ...bar,
      close: bar.date === "2025-01-01" ? 20 : bar.close,
    })),
  };
  const splitHistories = new Map([[
    JSON.stringify(["IBKR", "USD"]),
    splitHistory,
  ]]);
  const live = {
    ticker: "IBKR",
    currency: "USD",
    amount: .5,
    currentPrice: 40,
    totalNow: 20,
  } as IntegrationPortfolioPosition;
  const gifts = buildChartGifts(
    [receipt("2025-01-01"), receipt("2025-01-02", -.5)],
    splitHistories,
    new Map(),
    [live],
    rates,
    "2025-01-02",
    "2025-01-03",
  );
  deepStrictEqual(gifts.map((point) => point.valueUsd), [30, 60]);
  throws(
    () =>
      buildChartGifts(
        [receipt("2025-01-01", -1)],
        histories,
        new Map(),
        [],
        rates,
        "2025-01-01",
        "2025-01-03",
      ),
    /exceeds received/,
  );
});

Deno.test("gift market values use historical FX without converting them into index cash", () => {
  const foreign = new Map([[JSON.stringify(["IBKR", "USD"]), {
    ...history,
    currency: "EUR",
  }]]);
  const gifts = buildChartGifts(
    [receipt("2025-01-02")],
    foreign,
    new Map([["EUR", [{ date: "2025-01-01", factor: 2 }]]]),
    [],
    rates,
    "2025-01-01",
    "2025-01-03",
  );
  equal(gifts[1].valueUsd, 40);
  equal(gifts[2].valueUsd, 60);
  ok(gifts.every((point) => Number.isFinite(point.valueUsd)));
});
