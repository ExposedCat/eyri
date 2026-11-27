import { equal, ok } from "node:assert/strict";
import { percentageGrid, percentageGridLabel } from "./chart_grid.ts";

Deno.test("a portfolio spanning -86% to 112% has readable 10-point labels and 5-point minor lines", () => {
  const grid = percentageGrid([-86, 112, 10.97, null]);
  equal(grid.step, 10);
  ok(grid.min < -86 && grid.max > 112);
  ok(grid.max - grid.min < 300, "Avoid the old oversized ±150% domain");
  equal(grid.ticks[1].value - grid.ticks[0].value, 5);
  ok(grid.ticks.filter(tick => tick.major).length > 15);
  ok(grid.ticks.some(tick => tick.major && tick.value === 0));
});

Deno.test("percentage grids retain decimal detail for small returns and stay finite for flat or missing values", () => {
  for (const values of [[0], [null], [0.12, .41, null, NaN], [-.002, .003]]) {
    const grid = percentageGrid(values);
    ok(Number.isFinite(grid.min) && Number.isFinite(grid.max));
    ok(grid.min < grid.max && grid.ticks.length < 60);
    ok(grid.ticks.every(tick => Number.isFinite(tick.value)));
  }
  equal(percentageGridLabel(.25), "0.25%");
  equal(percentageGridLabel(-0), "0%");
});

Deno.test("percentage grids never render below -100% even with padding, deep losses, or large steps", () => {
  for (const [values, intervals] of [
    [[-95, 112], 22],
    [[-99, 10], 22],
    [[-100, 0], 22],
    [[-86, 200], 22],
    [[-100, 50], 10],
    [[0, 3000], 22],
    [[-50, 2000], 10],
    [[-50, 8000], 22],
    [[-120, 50], 22],
  ] as [number[], number][]) {
    const grid = percentageGrid(values, intervals);
    equal(grid.min, -100, `Expected -100% floor for ${JSON.stringify(values)} (intervals=${intervals})`);
    ok(grid.ticks.every(tick => tick.value >= -100 && tick.value <= grid.max));
    ok(grid.ticks.some(tick => tick.major && tick.value === 0));
    ok(grid.ticks.filter(tick => tick.major).every(tick => Math.abs(tick.value / grid.step - Math.round(tick.value / grid.step)) < 1e-9));
  }
});
