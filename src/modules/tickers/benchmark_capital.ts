import type { IntegrationAccountPerformance, IntegrationOrder } from "../integrations/types.ts";
import type { ChartBenchmark } from "./chart_benchmark.ts";

// Keep full portfolio funding even when the actual curve filters asset classes.
export type BenchmarkSource = {
  accountPerformances: IntegrationAccountPerformance[];
  // Purchases before asset filtering, scoped and scaled to the selected view.
  orders?: IntegrationOrder[];
};

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
