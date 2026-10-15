import { deepStrictEqual, equal, ok, rejects, throws } from "node:assert/strict";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { Database } from "@db/sqlite";
import {
  type AllTimeDataset,
  ensureChartSchema,
  hash,
  renderAllTimeChart,
} from "./alltime_chart.ts";
import { renderAllTimeDatasets } from "./alltime_chart_renderer.ts";
import { buildChartBenchmark } from "./chart_benchmark.ts";

const dataset: AllTimeDataset = {
  userId: 1,
  label: "Zero crossings",
  bucketName: null,
  points: [10, -10, 10, -10].map((percentage, index) => ({
    date: `2026-01-0${index + 1}`,
    percentage,
    gain: percentage * 10,
  })),
};

const benchmark = buildChartBenchmark({
  symbol: "CSPX.L", currency: "USD", instrumentType: "ETF", splits: [],
  bars: [{ date: "2026-01-01", close: 100 }, { date: "2026-01-04", close: 105 }],
}, [{ date: "2026-01-01", amountUsd: 1000 }], "2026-01-01", "2026-01-04");
const withBenchmark = { ...dataset, benchmark };

Deno.test("rendered stroke switches color exactly at zero, including between opposite-sign samples", async () => {
  const image = await loadImage(renderAllTimeDatasets([dataset]));
  const canvas = createCanvas(image.width, image.height);
  const context = canvas.getContext("2d");
  context.drawImage(image, 0, 0);
  const { data } = context.getImageData(0, 0, image.width, image.height);
  const matches = (x: number, y: number, rgb: number[]) => {
    const offset = (y * image.width + x) * 4;
    return rgb.every((value, index) => data[offset + index] === value);
  };
  // Locate the gray zero gridline away from the stroke, not an assumed pixel.
  let zero = -1;
  for (let y = 100; y < 1100; y++) {
    if (matches(2200, y, [132, 148, 166])) {
      zero = y;
      break;
    }
  }
  ok(zero > 100, "Zero baseline is visible");
  let green = 0,
    red = 0;
  for (let y = 100; y < 1100; y++) {
    for (let x = 250; x < 2000; x++) {
      if (matches(x, y, [99, 216, 171])) {
        green++;
        ok(y <= zero + 1, `Green stroke below zero at ${x},${y}`);
      }
      if (matches(x, y, [250, 137, 145])) {
        red++;
        ok(y >= zero - 1, `Red stroke above zero at ${x},${y}`);
      }
    }
  }
  ok(green > 100 && red > 100, "Both sides of the continuous stroke rendered");
});

Deno.test("Chart.js renderer ignores cached images from the old Python renderer", async () => {
  const db = new Database(":memory:");
  try {
    ensureChartSchema(db);
    const oldKey = await hash({ version: 3, datasets: [dataset] });
    db.prepare(
      "INSERT INTO alltime_render_cache(cache_key,png,created_at) VALUES (?,?,?)",
    ).run(oldKey, new Uint8Array([1, 2, 3]), Date.now());
    const png = await renderAllTimeChart(db, [withBenchmark]);
    deepStrictEqual([...png.slice(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
    deepStrictEqual(
      await renderAllTimeChart(db, [withBenchmark]),
      png,
    );
    equal(
      (
        db.prepare("SELECT COUNT(*) AS n FROM alltime_render_cache").get() as {
          n: number;
        }
      ).n,
      2,
    );
  } finally {
    db.close();
  }
});

Deno.test("each participant has a translucent dashed benchmark in their own color", async () => {
  const makeBenchmark = (price: number) => buildChartBenchmark({
    symbol: "CSPX.L", currency: "USD", instrumentType: "ETF", splits: [],
    bars: [100, price, price, price].map((close, i) => ({ date: `2026-01-0${i+1}`, close })),
  }, [{ date: "2026-01-01", amountUsd: 1000 }], "2026-01-01", "2026-01-04");
  const datasets = [
    { ...dataset, points: dataset.points.map(p => ({ ...p, percentage: 20 })), benchmark: makeBenchmark(105) },
    { ...dataset, userId: 2, label: "Second participant", points: dataset.points.map(p => ({ ...p, percentage: -20 })), benchmark: makeBenchmark(95) },
  ];
  const png = renderAllTimeDatasets(datasets);
  const image = await loadImage(png);
  const canvas = createCanvas(image.width, image.height);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(image, 0, 0);
  const { data } = ctx.getImageData(0, 0, image.width, image.height);
  const matches = (x: number, y: number, rgb: number[]) => rgb.every((v, i) => data[(y*image.width+x)*4+i] === v);
  for (const rgb of [[58, 120, 102], [133, 81, 89]]) {
    let bestCount = 0, bestRuns = 0;
    // Inspect the middle of the plot, away from the solid ±20% strokes whose
    // antialiased edges can coincidentally match a half-opacity color.
    for (let y=300; y<800; y++) {
      let count=0, runs=0, previous=false;
      for(let x=250; x<2000; x++) {
        const hit=matches(x,y,rgb);
        if(hit) { count++; if(!previous) runs++; }
        previous=hit;
      }
      if(count>bestCount) { bestCount=count; bestRuns=runs; }
    }
    ok(bestCount>100, `Visible half-opacity participant color ${rgb}: ${bestCount}`);
    ok(bestRuns>10, `Separate dash segments for ${rgb}: ${bestRuns}`);
  }
  await Deno.writeFile("/tmp/eyri-personal-benchmarks-test.png", png);
});

Deno.test("render cache includes each person's frozen benchmark, and legacy charts must be recreated", async () => {
  const db = new Database(":memory:");
  try {
    const first = await renderAllTimeChart(db, [withBenchmark]);
    const changed = structuredClone(withBenchmark);
    changed.benchmark.points.at(-1)!.percentage = 10;
    changed.benchmark.points.at(-1)!.gain = 100;
    const next = await renderAllTimeChart(db, [changed]);
    ok(!first.every((value, index) => value === next[index]));
    deepStrictEqual(await renderAllTimeChart(db, [withBenchmark]), first);
    equal((db.prepare("SELECT COUNT(*) AS n FROM alltime_render_cache").get() as { n: number }).n, 2);
    await rejects(renderAllTimeChart(db, [dataset]), /Create a new chart with \/chart/);
  } finally { db.close(); }
});

Deno.test("empty charts fail clearly before native rendering", () => {
  throws(() => renderAllTimeDatasets([]), /No performance points/);
  throws(
    () => renderAllTimeDatasets([{ ...dataset, points: [] }]),
    /No performance points/,
  );
});

Deno.test("Momentum changes the rendered legend and cache even when both indices have the same returns", async () => {
  const db = new Database(":memory:");
  try {
    const sp500 = await renderAllTimeChart(db, [withBenchmark]);
    const momentum = { ...withBenchmark, benchmark: { ...benchmark, symbol: "IUMO.L", label: "If Momentum (IUMO.L)" } };
    const png = await renderAllTimeChart(db, [momentum]);
    ok(!sp500.every((value, index) => value === png[index]));
    deepStrictEqual(await renderAllTimeChart(db, [momentum]), png);
    await Deno.writeFile("/tmp/eyri-momentum-test.png", png);
  } finally { db.close(); }
});
