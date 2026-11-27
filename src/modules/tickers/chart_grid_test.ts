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

Deno.test("percentage grids never extend below -100%", () => {
  for (const values of [[-86, 112], [-100, 5], [-99.9, 300], [-64, 10]]) {
    const grid = percentageGrid(values);
    ok(grid.min >= -100 && grid.ticks.every(tick => tick.value >= -100));
  }
});
