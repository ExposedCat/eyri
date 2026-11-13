import { deepStrictEqual, equal, throws } from "node:assert/strict";
import { chartComparisonNotes, chartPointValue, chartUsesPercentages, requireVisibleChart } from "./chart_points.ts";

Deno.test("missing percentages leave gaps without converting the whole chart to money", () => {
  const points = [{ date: "2025-01-01", gain: 0, percentage: null },
    { date: "2025-01-02", gain: 100, percentage: 10 }];
  equal(chartUsesPercentages([{ kind: "alltime", points }]), true);
  equal(chartPointValue(points[0], true), null);
  equal(chartPointValue(points[1], true), 10);
  equal(chartUsesPercentages([{ kind: "worth", points }]), false);
  equal(chartUsesPercentages([{ kind: "alltime", points: [points[0]] }]), false);
  equal(chartPointValue({ ...points[0], gain: null }, false), null);
});

Deno.test("comparison uses money if a participant has no percentages, but keeps percentages across isolated gaps", () => {
  const known = { label: "First", kind: "alltime", points: [{ date: "2025-01-01", gain: 100, percentage: 10 }] };
  const missing = { ...known, label: "Second", points: [{ ...known.points[0], percentage: null }] };
  equal(chartUsesPercentages([known, missing]), false);
  deepStrictEqual(chartComparisonNotes([known, missing]), ["Comparing P/L in USD; no percentages for Second."]);
  requireVisibleChart([known, missing]);
  const partial = { ...missing, points: [...missing.points, ...known.points] };
  equal(chartUsesPercentages([known, partial]), true);
  deepStrictEqual(chartComparisonNotes([known, partial]), []);
  throws(() => requireVisibleChart([known, { ...missing, points: [{ date: "2025-01-01", gain: null, percentage: null }] }]),
    /Second: no usable values/);
});
