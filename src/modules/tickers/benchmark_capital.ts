import type { IntegrationAccountPerformance, IntegrationOrder, IntegrationPortfolioPosition } from "../integrations/types.ts";
import type { ChartBenchmark } from "./chart_benchmark.ts";

// Keep full portfolio funding even when the actual curve filters asset classes.
export type BenchmarkSource = {
  accountPerformances: IntegrationAccountPerformance[];
  // Purchases before asset filtering, scoped and scaled to the selected view.
  orders?: IntegrationOrder[];
  positions?: IntegrationPortfolioPosition[];
};

export type FundingBasisPoint = { date: string; deposits: number; withdrawals: number };

export function benchmarkWithFundingBasis(benchmark: ChartBenchmark, basis?: FundingBasisPoint[]) {
  if (!basis) return benchmark;
  const byDate = new Map(basis.map(point => [point.date, point]));
  return { ...benchmark, points: benchmark.points.map(point => {
    const funding = byDate.get(point.date);
    if (!funding || point.value === undefined) throw new Error("Index snapshot lacks its top-up currency basis. Create a new chart with /chart.");
    const gain = point.value + funding.withdrawals - funding.deposits;
    return { ...point, gain, depositsUsd: funding.deposits,
      percentage: funding.deposits > 0 ? gain / funding.deposits * 100 : 0 };
  }) };
}

// One buy-and-hold portfolio, displayed using the selected report's metric.
export function benchmarkForKind(benchmark: ChartBenchmark, kind: "perf" | "alltime" | "worth") {
  if (kind === "alltime") return benchmark;
  return { ...benchmark, points: benchmark.points.map(point => {
    if (point.value === undefined) throw new Error("Index snapshot lacks its portfolio value. Create a new chart with /chart.");
    if (kind === "worth") return { ...point, gain: point.value, percentage: 0 };
    if (point.openCostUsd === undefined) throw new Error("Index snapshot lacks its book cost. Create a new chart with /chart.");
    const gain = point.value - point.openCostUsd;
    return { ...point, gain, percentage: point.openCostUsd ? gain / point.openCostUsd * 100 : 0 };
  }) };
}
