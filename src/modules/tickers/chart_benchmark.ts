import type { PriceHistory } from "../market_data/history.ts";
import { dayAfter } from "../market_data/history.ts";

export const CHART_BENCHMARK_SYMBOL = "CSPX.L";
export const CHART_BENCHMARKS = {
  sp500: { name: "S&P 500", symbol: CHART_BENCHMARK_SYMBOL },
  momentum: { name: "Momentum", symbol: "IUMO.L" },
} as const;
export type ChartBenchmarkIndex = keyof typeof CHART_BENCHMARKS;
export function chartBenchmarkIndex(symbol?: string): ChartBenchmarkIndex {
  return symbol === CHART_BENCHMARKS.momentum.symbol ? "momentum" : "sp500";
}
export type BenchmarkPurchase = { date: string; amountUsd: number };
export type ChartBenchmark = {
  label: string;
  symbol: string;
  asOf: string;
  points: { date: string; percentage: number; gain: number }[];
};

// Buy fractional index ETF shares for every actual purchase, then hold them.
// Sales of the original instruments do not sell the ETF or remove its cost.
export function buildChartBenchmark(
  history: PriceHistory,
  purchases: BenchmarkPurchase[],
  start: string,
  end: string,
  index: ChartBenchmarkIndex = "sp500",
): ChartBenchmark {
  const { name, symbol } = CHART_BENCHMARKS[index];
  if (start > end) throw new Error(`Invalid ${name} benchmark date range.`);
  if (
    history.symbol !== symbol || history.currency !== "USD" ||
    history.instrumentType !== "ETF"
  ) throw new Error(`${name} benchmark must use the ${symbol} USD ETF listing.`);
  if (
    history.splits.some((split) =>
      !Number.isFinite(split.ratio) || split.ratio <= 0
    )
  ) throw new Error(`Invalid ${name} benchmark stock split.`);
  if (purchases.some((purchase) =>
    !/^\d{4}-\d{2}-\d{2}$/.test(purchase.date) ||
    !Number.isFinite(Date.parse(purchase.date)) ||
    !Number.isFinite(purchase.amountUsd) || purchase.amountUsd < 0
  )) throw new Error(`Invalid ${name} benchmark purchase.`);

  // The shared cache stores raw closes. Express all closes in end-date share
  // units so a split changes neither the hypothetical investment nor its gain.
  const bars = history.bars.filter((bar) => bar.date <= end).map((bar) => ({
    ...bar,
    close: bar.close /
      history.splits.filter((split) =>
        split.date > bar.date && split.date <= end
      ).reduce((factor, split) => factor * split.ratio, 1),
  })).sort((a, b) => a.date.localeCompare(b.date));
  if (
    !bars.length || bars.some((bar, index) =>
      !Number.isFinite(bar.close) || bar.close <= 0 ||
      (index > 0 && bar.date === bars[index - 1].date)
    )
  ) throw new Error(`${name} benchmark has no valid prices for this chart.`);

  const buys = purchases.filter((p) => p.amountUsd > 0 && p.date <= end)
    .sort((a, b) => a.date.localeCompare(b.date));
  if (buys.length && buys[0].date < bars[0].date) {
    throw new Error(`${name} benchmark closing price unavailable on ${buys[0].date}.`);
  }
  const points: ChartBenchmark["points"] = [];
  let barIndex = 0, buyIndex = 0, shares = 0, cost = 0;
  const first = buys.length && buys[0].date < start ? buys[0].date : start;
  for (let date = first; date <= end; date = dayAfter(date)) {
    while (barIndex + 1 < bars.length && bars[barIndex + 1].date <= date) barIndex++;
    while (buyIndex < buys.length && buys[buyIndex].date <= date) {
      const purchase = buys[buyIndex++];
      shares += purchase.amountUsd / bars[barIndex].close;
      cost += purchase.amountUsd;
    }
    if (date < start) continue;
    const gain = cost === 0 ? 0 : shares * bars[barIndex].close - cost;
    points.push({ date, percentage: cost === 0 ? 0 : gain / cost * 100, gain });
  }
  return {
    label: `If ${name} (${symbol})`,
    symbol,
    asOf: bars.at(-1)!.date,
    points,
  };
}

export async function loadChartBenchmark(
  purchases: BenchmarkPurchase[],
  start: string,
  end: string,
  cache: {
    get(symbol: string, start: string, end?: string): Promise<PriceHistory>;
  },
  index: ChartBenchmarkIndex = "sp500",
): Promise<ChartBenchmark> {
  const { name, symbol } = CHART_BENCHMARKS[index];
  const earliest = purchases.filter((p) => p.amountUsd > 0 && p.date <= end)
    .map((p) => p.date).sort()[0];
  try {
    const history = await cache.get(
      symbol,
      dayAfter(earliest && earliest < start ? earliest : start, -7),
      dayAfter(end),
    );
    return buildChartBenchmark(history, purchases, start, end, index);
  } catch (cause) {
    throw new Error(
      `${name} benchmark (${symbol}) prices unavailable for your purchase history. Try again shortly.`,
      { cause },
    );
  }
}
