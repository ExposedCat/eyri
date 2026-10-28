import { deepStrictEqual, equal, ok, rejects, throws } from "node:assert/strict";
import type { PriceHistory } from "../market_data/history.ts";
import { buildChartBenchmark, loadChartBenchmark } from "./chart_benchmark.ts";

const history: PriceHistory = {
  symbol: "CSPX.L", currency: "USD", instrumentType: "ETF", splits: [],
  bars: [
    { date: "2026-01-02", close: 100 },
    { date: "2026-04-01", close: 110 },
    { date: "2026-05-01", close: 121 },
  ],
};
const purchases = [
  { date: "2026-01-02", amountUsd: 1000 },
  { date: "2026-04-01", amountUsd: 1000 },
];
const near = (actual: number, expected: number) => ok(Math.abs(actual - expected) < 1e-8, `${actual} != ${expected}`);

Deno.test("personal benchmark invests each purchase amount on its date: 10%, then 5%, then 15.5%", () => {
  const result = buildChartBenchmark(history, purchases, "2026-01-02", "2026-05-01");
  equal(result.label, "If S&P 500 (CSPX.L)");
  equal(result.asOf, "2026-05-01");
  equal(result.points[0].percentage, 0);
  // Add a close before the April buy to observe the first lot's gain separately.
  const h = { ...history, bars: [history.bars[0], { date: "2026-03-31", close: 110 }, ...history.bars.slice(1)] };
  const detailed = buildChartBenchmark(h, purchases, "2026-01-02", "2026-05-01");
  near(detailed.points.find(p => p.date === "2026-03-31")!.percentage, 10);
  near(detailed.points.find(p => p.date === "2026-04-01")!.percentage, 5);
  near(result.points.at(-1)!.percentage, 15.5);
  near(result.points.at(-1)!.gain, 310);
  equal(history.bars[0].close, 100);
  equal(purchases[0].amountUsd, 1000);
});

Deno.test("relative purchase amounts change returns; scaling every purchase together does not", () => {
  const run = (first: number, second: number) => buildChartBenchmark(history, [
    { ...purchases[0], amountUsd: first }, { ...purchases[1], amountUsd: second },
  ], "2026-01-02", "2026-05-01").points.at(-1)!;
  near(run(1000, 0).percentage, 21);
  near(run(0, 1000).percentage, 10);
  near(run(1_000_000, .0001).percentage, 21);
  near(run(.0001, 1_000_000).percentage, 10);
  near(run(1000, 3000).percentage, 12.75);
  near(run(10, 30).percentage, 12.75);
});

Deno.test("weekend purchases carry the previous close, same-day buys aggregate, and future purchases are excluded", () => {
  const result = buildChartBenchmark(history, [
    { date: "2026-01-03", amountUsd: 200 },
    { date: "2026-01-03", amountUsd: 300 },
    { date: "2026-04-02", amountUsd: 9999 },
  ], "2026-01-02", "2026-04-01");
  equal(result.points[0].gain, 0);
  equal(result.points[1].gain, 0);
  near(result.points.at(-1)!.gain, 50);
  near(result.points.at(-1)!.percentage, 10);
  equal(result.asOf, "2026-04-01");
});

Deno.test("a clipped chart retains investments made before its visible start, with no rebasing", () => {
  const result = buildChartBenchmark(history, purchases, "2026-04-01", "2026-05-01");
  equal(result.points[0].date, "2026-04-01");
  near(result.points[0].percentage, 5);
  near(result.points.at(-1)!.percentage, 15.5);
});

Deno.test("benchmark adjusts splits across purchases and ignores splits beyond the snapshot", () => {
  const h = {
    ...history,
    bars: [
      { date: "2026-01-02", close: 100 },
      { date: "2026-04-01", close: 50 },
      { date: "2026-05-01", close: 55 },
    ],
    splits: [{ date: "2026-04-01", ratio: 2 }, { date: "2027-01-01", ratio: 10 }],
  };
  const result = buildChartBenchmark(h, purchases, "2026-01-02", "2026-05-01");
  equal(result.points.find(p => p.date === "2026-04-01")!.percentage, 0);
  near(result.points.at(-1)!.gain, 200);
  near(result.points.at(-1)!.percentage, 10);
});

Deno.test("benchmark represents zero-cost awards as no investment, not imaginary S&P shares", () => {
  const result = buildChartBenchmark(history, [{ ...purchases[0], amountUsd: 0 }], "2026-01-02", "2026-05-01");
  ok(result.points.every(p => p.gain === 0 && p.percentage === 0));
});

Deno.test("benchmark never silently moves an actual purchase to the ETF's first available date", () => {
  throws(() => buildChartBenchmark(history, [
    { date: "2009-01-01", amountUsd: 100 },
  ], "2009-01-01", "2026-05-01"), /closing price unavailable on 2009-01-01/);
});

Deno.test("benchmark rejects wrong listings and invalid prices or purchase amounts", () => {
  for (const change of [
    { symbol: "CSP1.L" }, { currency: "GBX" }, { instrumentType: "EQUITY" },
    { bars: [] }, { bars: [{ date: "2026-01-02", close: 0 }] },
    { bars: [{ date: "2026-01-02", close: NaN }] },
    { bars: [history.bars[0], history.bars[0]] },
    { splits: [{ date: "2026-04-01", ratio: 0 }] },
  ]) {
    throws(() => buildChartBenchmark({ ...history, ...change }, purchases, "2026-01-02", "2026-05-01"));
  }
  for (const amountUsd of [NaN, Infinity]) {
    throws(() => buildChartBenchmark(history, [{ ...purchases[0], amountUsd }], "2026-01-02", "2026-05-01"), /Invalid.*purchase/);
  }
});

Deno.test("benchmark loader requests full purchase history even when the chart starts later", async () => {
  const calls: unknown[][] = [];
  const result = await loadChartBenchmark(purchases, "2026-04-01", "2026-05-01", {
    get: (...args) => { calls.push(args); return Promise.resolve(history); },
  });
  deepStrictEqual(calls, [["CSPX.L", "2025-12-26", "2026-05-02"]]);
  near(result.points[0].percentage, 5);
});

Deno.test("missing benchmark data produces an actionable error", async () => {
  await rejects(loadChartBenchmark(purchases, "2026-01-02", "2026-05-01", {
    get: () => Promise.reject(new Error("Yahoo HTTP 429")),
  }), /CSPX.L.*unavailable/);
});

Deno.test("Momentum replays purchases against IUMO.L and rejects other listings or currencies", async () => {
  const momentum = { ...history, symbol: "IUMO.L" };
  const result = buildChartBenchmark(momentum, purchases, "2026-01-02", "2026-05-01", "momentum");
  equal(result.symbol, "IUMO.L");
  equal(result.label, "If Momentum (IUMO.L)");
  near(result.points.at(-1)!.percentage, 15.5);
  throws(() => buildChartBenchmark(history, purchases, "2026-01-02", "2026-05-01", "momentum"), /IUMO.L USD ETF/);
  throws(() => buildChartBenchmark({ ...momentum, currency: "GBP" }, purchases, "2026-01-02", "2026-05-01", "momentum"), /IUMO.L USD ETF/);
  const calls: unknown[][] = [];
  const loaded = await loadChartBenchmark(purchases, "2026-04-01", "2026-05-01", {
    get: (...args) => { calls.push(args); return Promise.resolve(momentum); },
  }, "momentum");
  deepStrictEqual(calls, [["IUMO.L", "2025-12-26", "2026-05-02"]]);
  near(loaded.points[0].percentage, 5);
  await rejects(loadChartBenchmark(purchases, "2026-01-02", "2026-05-01", {
    get: () => Promise.reject(new Error("HTTP 429")),
  }, "momentum"), /Momentum.*IUMO.L.*unavailable/);
});
