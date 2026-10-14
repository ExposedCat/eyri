import {
  deepStrictEqual,
  equal,
  ok,
  rejects,
  throws,
} from "node:assert/strict";
import type { PriceHistory } from "../market_data/history.ts";
import { buildChartBenchmark, loadChartBenchmark } from "./chart_benchmark.ts";

const history: PriceHistory = {
  symbol: "CSPX.L",
  currency: "USD",
  instrumentType: "ETF",
  splits: [],
  bars: [
    { date: "2026-01-02", close: 100 },
    { date: "2026-01-05", close: 105 },
    { date: "2026-01-06", close: 102 },
  ],
};

Deno.test("CSPX benchmark rebases at the portfolio baseline and carries closes over non-trading days", () => {
  const result = buildChartBenchmark(history, "2026-01-03", "2026-01-07");
  equal(result.label, "S&P 500 (CSPX.L)");
  equal(result.asOf, "2026-01-06");
  deepStrictEqual(result.points.map((p) => p.date), [
    "2026-01-03",
    "2026-01-04",
    "2026-01-05",
    "2026-01-06",
    "2026-01-07",
  ]);
  deepStrictEqual(
    result.points.map((p) => Math.round(p.percentage * 100) / 100),
    [0, 0, 5, 2, 2],
  );
  equal(history.bars[0].close, 100);
});

Deno.test("benchmark uses the full comparison span and ignores prices after the published snapshot", async () => {
  const calls: unknown[][] = [];
  const result = await loadChartBenchmark([
    { points: [{ date: "2026-01-05" }, { date: "2026-01-05" }] },
    { points: [{ date: "2026-01-03" }, { date: "2026-01-04" }] },
  ], {
    get: (...args) => {
      calls.push(args);
      return Promise.resolve(history);
    },
  });
  deepStrictEqual(calls, [["CSPX.L", "2025-12-27", "2026-01-06"]]);
  equal(result.asOf, "2026-01-05");
  equal(result.points[0].date, "2026-01-03");
  equal(result.points.at(-1)!.date, "2026-01-05");
});

Deno.test("benchmark never invents prices before the ETF history begins", () => {
  const result = buildChartBenchmark(history, "2025-12-01", "2026-01-06");
  equal(result.points[0].date, "2026-01-02");
  equal(result.points[0].percentage, 0);
  equal(result.points.length, 5);
  throws(
    () => buildChartBenchmark(history, "2025-12-01", "2025-12-31"),
    /no valid prices/,
  );
});

Deno.test("benchmark returns account for stock splits rather than showing a split as a loss", () => {
  const splitHistory = {
    ...history,
    splits: [{ date: "2026-01-05", ratio: 2 }],
    bars: [
      { date: "2026-01-02", close: 100 },
      { date: "2026-01-05", close: 50 },
      { date: "2026-01-06", close: 55 },
    ],
  };
  const result = buildChartBenchmark(splitHistory, "2026-01-02", "2026-01-06");
  equal(result.points[3].percentage, 0);
  ok(Math.abs(result.points.at(-1)!.percentage - 10) < 1e-9);
});

Deno.test("benchmark rejects the wrong listing, currency, instrument type and invalid prices", () => {
  for (
    const change of [
      { symbol: "CSP1.L" },
      { currency: "GBX" },
      { instrumentType: "EQUITY" },
      { bars: [] },
      { bars: [{ date: "2026-01-02", close: 0 }] },
      { bars: [{ date: "2026-01-02", close: NaN }] },
      { bars: [history.bars[0], history.bars[0]] },
      { splits: [{ date: "2026-01-05", ratio: 0 }] },
    ]
  ) {
    throws(() =>
      buildChartBenchmark({ ...history, ...change }, "2026-01-02", "2026-01-06")
    );
  }
});

Deno.test("missing benchmark prices produce an actionable error and empty portfolios make no request", async () => {
  const cache = { get: () => Promise.reject(new Error("Yahoo HTTP 429")) };
  await rejects(
    loadChartBenchmark([{ points: [{ date: "2026-01-02" }] }], cache),
    /CSPX.L.*unavailable/,
  );
  await rejects(
    loadChartBenchmark([], {
      get: () => {
        throw new Error("Unexpected request");
      },
    }),
    /No performance points/,
  );
});
