import type { PriceHistory } from "../market_data/history.ts";
import { dayAfter } from "../market_data/history.ts";

export const CHART_BENCHMARK_SYMBOL = "CSPX.L";
export type ChartBenchmark = {
  label: string;
  symbol: string;
  asOf: string;
  points: { date: string; percentage: number }[];
};

export function buildChartBenchmark(
  history: PriceHistory,
  start: string,
  end: string,
): ChartBenchmark {
  if (start > end) throw new Error("Invalid S&P 500 benchmark date range.");
  if (
    history.symbol !== CHART_BENCHMARK_SYMBOL || history.currency !== "USD" ||
    history.instrumentType !== "ETF"
  ) throw new Error("S&P 500 benchmark must use the CSPX.L USD ETF listing.");
  if (
    history.splits.some((split) =>
      !Number.isFinite(split.ratio) || split.ratio <= 0
    )
  ) {
    throw new Error("Invalid S&P 500 benchmark stock split.");
  }
  // The shared cache stores unadjusted closes. Normalize to end-date share
  // units so a split cannot look like an investment loss.
  const bars = history.bars.filter((bar) => bar.date <= end).map((bar) => ({
    ...bar,
    close: bar.close /
      history.splits.filter((split) =>
        split.date > bar.date && split.date <= end
      ).reduce((factor, split) => factor * split.ratio, 1),
  }))
    .sort((a, b) => a.date.localeCompare(b.date));
  if (
    !bars.length ||
    bars.some((bar, index) =>
      !Number.isFinite(bar.close) || bar.close <= 0 ||
      (index > 0 && bar.date === bars[index - 1].date)
    )
  ) throw new Error("S&P 500 benchmark has no valid prices for this chart.");

  // Start at the last close on/before the portfolio's baseline date. A chart
  // predating the ETF starts the benchmark at its first available close.
  let index = 0;
  while (index + 1 < bars.length && bars[index + 1].date <= start) index++;
  const first = bars[index].date > start ? bars[index].date : start;
  const base = bars[index].close;
  const points: ChartBenchmark["points"] = [];
  for (let date = first; date <= end; date = dayAfter(date)) {
    while (index + 1 < bars.length && bars[index + 1].date <= date) index++;
    points.push({ date, percentage: (bars[index].close / base - 1) * 100 });
  }
  return {
    label: "S&P 500 (CSPX.L)",
    symbol: CHART_BENCHMARK_SYMBOL,
    asOf: bars.at(-1)!.date,
    points,
  };
}

export async function loadChartBenchmark(
  datasets: { points: { date: string }[] }[],
  cache: {
    get(symbol: string, start: string, end?: string): Promise<PriceHistory>;
  },
): Promise<ChartBenchmark> {
  if (!datasets.length || datasets.some((dataset) => !dataset.points.length)) {
    throw new Error("No performance points to chart.");
  }
  const start = datasets.map((dataset) => dataset.points[0].date).sort()[0];
  const end = datasets.map((dataset) => dataset.points.at(-1)!.date).sort().at(
    -1,
  )!;
  try {
    const history = await cache.get(
      CHART_BENCHMARK_SYMBOL,
      dayAfter(start, -7),
      dayAfter(end),
    );
    return buildChartBenchmark(history, start, end);
  } catch (cause) {
    throw new Error(
      "S&P 500 benchmark (CSPX.L) prices unavailable. Try /chart again shortly.",
      { cause },
    );
  }
}
