import { deepStrictEqual, equal } from "node:assert/strict";
import { parsePerformanceArgs } from "./performance_command.ts";

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
