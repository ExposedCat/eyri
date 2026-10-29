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
