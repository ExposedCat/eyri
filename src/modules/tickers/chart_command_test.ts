import { deepStrictEqual, equal, match } from "node:assert/strict";
import { chartWindowStart, clipChartDataset, parseChartArgs } from "./chart_command.ts";
import type { AllTimeDataset } from "./alltime_chart.ts";
import { switchChartBenchmarks } from "./alltime_chart.ts";
import { Database } from "@db/sqlite";
import { buildChartBenchmark } from "./chart_benchmark.ts";

Deno.test("chart arguments separate explicit widgets, cumulative windows, filters and buckets", () => {
  deepStrictEqual(parseChartArgs(""), { widget: false, filter: null, bucketName: null, window: undefined });
  const args = parseChartArgs("widget 1y 2m 3w 4d stocks Core")!;
  equal(args.widget, true);
  equal(args.filter, "stocks");
  equal(args.bucketName, "Core");
  deepStrictEqual(args.window, { years: 1, months: 2, weeks: 3, days: 4 });
  deepStrictEqual(parseChartArgs("1y2m3w4d widget stocks Core"), args);
  for (const invalid of ["perf", "dpnl", "worth", "alltime", "widget widget", "0d", "-1y", "1.5m", "1h", "1m 2m", "9000000000000000d", "100y 1w", "stocks options"]) {
    equal(parseChartArgs(invalid), null, invalid);
  }
});

Deno.test("chart windows subtract calendar years/months with month-end clamping, then weeks/days", () => {
  equal(chartWindowStart("2026-11-13", { years: 1, months: 2, weeks: 3, days: 4 }), "2025-08-19");
  equal(chartWindowStart("2024-02-29", { years: 1, months: 0, weeks: 0, days: 0 }), "2023-02-28");
  equal(chartWindowStart("2024-03-31", { years: 0, months: 1, weeks: 0, days: 0 }), "2024-02-29");
  equal(chartWindowStart("2026-11-13", { years: 0, months: 0, weeks: 0, days: 4 }), "2026-11-09");
});

Deno.test("cropping a chart preserves lifetime returns, earlier funding, gifts and index switching", async () => {
  const db = new Database(":memory:");
  const prices = { symbol: "CSPX.L", currency: "USD", instrumentType: "ETF", splits: [],
    bars: [{ date: "2025-01-01", close: 100 }, { date: "2025-02-01", close: 110 }, { date: "2025-03-01", close: 120 }] };
  const purchases = [{ date: "2025-01-01", amountUsd: 1000 }];
  const data: AllTimeDataset = {
    fundingReturnVersion: 6, kind: "alltime", userId: 1, label: "Portfolio", bucketName: null,
    points: prices.bars.map((bar, i) => ({ date: bar.date, gain: i * 100, percentage: i * 10 })),
    purchaseDates: ["2025-01-01", "2025-02-01"],
    benchmarkPurchases: purchases,
    benchmark: buildChartBenchmark(prices, purchases, "2025-01-01", "2025-03-01"),
  };
  try {
    const clipped = clipChartDataset(data, "2025-02-01", "2025-03-01");
    deepStrictEqual(clipped.points, data.points.slice(1));
    equal(clipped.points[0].percentage, 10);
    deepStrictEqual(clipped.purchaseDates, ["2025-02-01"]);
    deepStrictEqual(clipped.benchmarkPurchases, purchases);
    equal(clipped.benchmark!.points[0].date, "2025-02-01");
    const [switched] = await switchChartBenchmarks(db, [clipped], "momentum", {
      get: async (_symbol, start) => { match(start, /2024-12-25/); return { ...prices, symbol: "IUMO.L" }; },
    });
    equal(switched.benchmark!.points[0].percentage, 10);
    equal(switched.benchmark!.points.at(-1)!.percentage, 20);
    equal(data.points.length, 3);
    equal(data.benchmark!.points[0].date, "2025-01-01");
  } finally { db.close(); }
});
