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
export type BenchmarkPurchase = {
  date: string;
  // Cash invested at the exchange rate on this date.
  amountUsd: number;
  // Funding in account base currency converted at today's display rate, matching
  // accountReturn. USD accounts and cash-funded allocations use amountUsd.
  contributionUsd?: number;
  valuationCurrency?: string;
  allocation?: boolean;
};
// USD market value -> account-base value -> USD reporting value on each date.
export type BenchmarkValuations = Record<string, { date: string; factor: number }[]>;
export type ChartBenchmark = {
  label: string;
  symbol: string;
  asOf: string;
  points: { date: string; percentage: number; gain: number; value?: number; openCostUsd?: number }[];
};

export function buildChartBenchmark(
  history: PriceHistory,
  purchases: BenchmarkPurchase[],
  start: string,
  end: string,
  index: ChartBenchmarkIndex = "sp500",
  valuations: BenchmarkValuations = {},
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
    !Number.isFinite(purchase.amountUsd) ||
    (purchase.contributionUsd !== undefined &&
      (!Number.isFinite(purchase.contributionUsd) ||
        Math.sign(purchase.contributionUsd) !== Math.sign(purchase.amountUsd)))
  )) throw new Error(`Invalid ${name} benchmark purchase.`);
  for (const currency of new Set(purchases.map(p => p.valuationCurrency).filter((c): c is string => !!c))) {
    const rows = valuations[currency];
    if (!rows?.length || rows.some((row, i) => !Number.isFinite(row.factor) || row.factor <= 0 ||
      !/^\d{4}-\d{2}-\d{2}$/.test(row.date) || !Number.isFinite(Date.parse(row.date)) ||
      i > 0 && row.date <= rows[i - 1].date)) {
      throw new Error(`Invalid ${name} benchmark valuation FX for ${currency}.`);
    }
  }

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

  const buys = purchases.filter((p) => p.amountUsd !== 0 && p.date <= end)
    .sort((a, b) => a.date.localeCompare(b.date));
  if (buys.length && buys[0].date < bars[0].date) {
    throw new Error(`${name} benchmark closing price unavailable on ${buys[0].date}.`);
  }
  const points: ChartBenchmark["points"] = [];
  let barIndex = 0, buyIndex = 0, cost = 0, withdrawals = 0;
  const shares = new Map<string, number>();
  const bookCosts = new Map<string, number>();
  const costs = new Map<string, number>(), withdrawn = new Map<string, number>();
  const first = buys.length && buys[0].date < start ? buys[0].date : start;
  for (let date = first; date <= end; date = dayAfter(date)) {
    while (barIndex + 1 < bars.length && bars[barIndex + 1].date <= date) barIndex++;
    const cashFlows = new Map<string, number>();
    while (buyIndex < buys.length && buys[buyIndex].date <= date) {
      const purchase = buys[buyIndex++];
      const currency = purchase.valuationCurrency ?? "USD";
      cashFlows.set(currency, (cashFlows.get(currency) ?? 0) + purchase.amountUsd);
      const contribution = purchase.contributionUsd ?? purchase.amountUsd;
      if (purchase.allocation || purchase.amountUsd > 0) cost += contribution;
      else withdrawals -= contribution;
      if (purchase.allocation || purchase.amountUsd > 0) costs.set(currency, (costs.get(currency) ?? 0) + contribution);
      else withdrawn.set(currency, (withdrawn.get(currency) ?? 0) - contribution);
    }
    for (const [currency, cashFlow] of cashFlows) {
      const previous = shares.get(currency) ?? 0;
      const quantity = previous + cashFlow / bars[barIndex].close;
      if (quantity < -1e-7) throw new Error(`${name} benchmark cannot fund the account's withdrawals.`);
      bookCosts.set(currency, cashFlow >= 0 ? (bookCosts.get(currency) ?? 0) + cashFlow
        : (bookCosts.get(currency) ?? 0) * (previous ? Math.max(0, quantity) / previous : 0));
      shares.set(currency, Math.max(0, quantity));
    }
    if (cost < -1e-7) throw new Error(`${name} benchmark allocation exceeds contributed capital.`);
    cost = Math.max(0, cost);
    if (date < start) continue;
    let value = 0, dailyCost = 0, dailyWithdrawals = 0;
    for (const [currency, quantity] of shares) {
      let factor = 1;
      if (currency !== "USD") {
        const row = valuations[currency]?.findLast(row => row.date <= date);
        if (!row || Date.parse(date) - Date.parse(row.date) > 7 * 86_400_000) {
          throw new Error(`${name} benchmark valuation FX unavailable for ${currency} on ${date}.`);
        }
        factor = row.factor;
      }
      value += quantity * bars[barIndex].close;
      dailyCost += (costs.get(currency) ?? 0) / factor;
      dailyWithdrawals += (withdrawn.get(currency) ?? 0) / factor;
    }
    const gain = value + dailyWithdrawals - dailyCost;
    points.push({ date, percentage: dailyCost === 0 ? 0 : gain / dailyCost * 100, gain, value,
      openCostUsd: [...bookCosts.values()].reduce((sum, cost) => sum + cost, 0) });
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
  valuations: BenchmarkValuations = {},
): Promise<ChartBenchmark> {
  const { name, symbol } = CHART_BENCHMARKS[index];
  const earliest = purchases.filter((p) => p.amountUsd !== 0 && p.date <= end)
    .map((p) => p.date).sort()[0];
  try {
    const history = await cache.get(
      symbol,
      dayAfter(earliest && earliest < start ? earliest : start, -7),
      dayAfter(end),
    );
    return buildChartBenchmark(history, purchases, start, end, index, valuations);
  } catch (cause) {
    throw new Error(
      `${name} benchmark (${symbol}) unavailable: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    );
  }
}
