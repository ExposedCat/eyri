import { deepStrictEqual, equal } from "node:assert/strict";
import { parsePerformanceArgs, parseReportArgs } from "./performance_command.ts";

Deno.test("chart and number select report kinds, stock/option aliases, and a trailing bucket", () => {
  for (const kind of ["perf", "alltime", "worth", "dpnl"] as const) {
    for (const [alias, filter] of [["s", "stocks"], ["stocks", "stocks"], ["o", "options"], ["options", "options"]]) {
      deepStrictEqual(parseReportArgs(`${kind} ${alias} Core`, "perf", true), { kind, filter, bucketName: "Core" });
      deepStrictEqual(parseReportArgs(`${kind} ${alias}`, "perf", true), { kind, filter, bucketName: null });
    }
  }
  deepStrictEqual(parseReportArgs("", "alltime"), { kind: "alltime", filter: null, bucketName: null });
  deepStrictEqual(parseReportArgs("s Core", "perf", true), { kind: "perf", filter: "stocks", bucketName: "Core" });
  for (const input of ["dpnl", "alltime s o", "worth stocks Core extra", "perf s stocks"]) {
    equal(parseReportArgs(input, "alltime"), null, input);
  }
});

Deno.test("performance arguments accept optional asset filters before an optional bucket", () => {
  for (const input of [undefined, "", " \t "]) {
    deepStrictEqual(parsePerformanceArgs(input), { filter: null, bucketName: null });
  }
  deepStrictEqual(parsePerformanceArgs("Core"), { filter: null, bucketName: "Core" });
  for (const [filter, aliases] of [["stocks", ["s", "stocks", "STOCKS"]], ["options", ["o", "options", "OPTIONS"]]] as const) {
    for (const alias of aliases) {
      deepStrictEqual(parsePerformanceArgs(alias), { filter, bucketName: null });
      deepStrictEqual(parsePerformanceArgs(`  ${alias}\t Core  `), { filter, bucketName: "Core" });
    }
  }
  for (const input of ["Core stocks", "s o Core", "stocks Core extra"]) {
    equal(parsePerformanceArgs(input), null);
  }
});

Deno.test("dpnl arguments accept bought/b and boughtN/bN alongside asset filters and buckets", () => {
  for (const alias of ["b", "bought", "B", "BOUGHT"]) {
    deepStrictEqual(parsePerformanceArgs(alias, true), { filter: null, bought: { mode: "today" }, bucketName: null });
    deepStrictEqual(parsePerformanceArgs(`${alias} Core`, true), { filter: null, bought: { mode: "today" }, bucketName: "Core" });
    deepStrictEqual(parsePerformanceArgs(`s ${alias} Core`, true), { filter: "stocks", bought: { mode: "today" }, bucketName: "Core" });
    deepStrictEqual(parsePerformanceArgs(`${alias} o Core`, true), { filter: "options", bought: { mode: "today" }, bucketName: "Core" });
    deepStrictEqual(parseReportArgs(`dpnl ${alias} Core`, "perf", true), { kind: "dpnl", filter: null, bought: { mode: "today" }, bucketName: "Core" });
  }
  for (const [token, count] of [["b1", 1], ["b2", 2], ["bought2", 2], ["BOUGHT12", 12]] as const) {
    deepStrictEqual(parsePerformanceArgs(token, true), { filter: null, bought: { mode: "last", count }, bucketName: null });
    deepStrictEqual(parsePerformanceArgs(`stocks ${token} Core`, true), { filter: "stocks", bought: { mode: "last", count }, bucketName: "Core" });
    deepStrictEqual(parsePerformanceArgs(`${token} s Core`, true), { filter: "stocks", bought: { mode: "last", count }, bucketName: "Core" });
    deepStrictEqual(parseReportArgs(`dpnl ${token}`, "perf", true), { kind: "dpnl", filter: null, bought: { mode: "last", count }, bucketName: null });
  }
  // Non-dpnl commands still treat b/bought as ordinary bucket names.
  deepStrictEqual(parsePerformanceArgs("b"), { filter: null, bucketName: "b" });
  deepStrictEqual(parseReportArgs("perf b2", "perf", true), { kind: "perf", filter: null, bucketName: "b2" });
  for (const invalid of ["b0", "bought0", "b b2", "b bought", "s b o", "Core b", "b2 s Core extra"]) {
    equal(parsePerformanceArgs(invalid, true), null, invalid);
  }
});
