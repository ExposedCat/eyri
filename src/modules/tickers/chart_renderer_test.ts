import { deepStrictEqual, equal, ok, throws } from "node:assert/strict";
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

const benchmarkCache = {
  get: () =>
    Promise.resolve({
      symbol: "CSPX.L",
      currency: "USD",
      instrumentType: "ETF",
      splits: [],
      bars: [{ date: "2025-12-31", close: 100 }, {
        date: "2026-01-04",
        close: 105,
      }],
    }),
};

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
    const png = await renderAllTimeChart(db, [dataset], benchmarkCache);
    deepStrictEqual([...png.slice(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
    deepStrictEqual(
      await renderAllTimeChart(db, [dataset], benchmarkCache),
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

Deno.test("benchmark renders orange above and below zero while preserving portfolio colors", async () => {
  const benchmark = buildChartBenchmark(
    {
      symbol: "CSPX.L",
      currency: "USD",
      instrumentType: "ETF",
      splits: [],
      bars: [100, 95, 106, 97].map((close, index) => ({
        date: `2026-01-0${index + 1}`,
        close,
      })),
    },
    "2026-01-01",
    "2026-01-04",
  );
  const image = await loadImage(renderAllTimeDatasets([dataset], benchmark));
  const canvas = createCanvas(image.width, image.height);
  const context = canvas.getContext("2d");
  context.drawImage(image, 0, 0);
  const { data } = context.getImageData(0, 0, image.width, image.height);
  const matches = (x: number, y: number, rgb: number[]) => {
    const offset = (y * image.width + x) * 4;
    return rgb.every((value, index) => data[offset + index] === value);
  };
  let zero = -1;
  for (let y = 100; y < 1100; y++) {
    if (matches(2200, y, [132, 148, 166])) {
      zero = y;
      break;
    }
  }
  ok(zero > 100);
  let orangeAbove = 0, orangeBelow = 0, green = 0, red = 0;
  for (let y = 100; y < 1100; y++) {
    for (let x = 250; x < 2000; x++) {
      if (matches(x, y, [245, 166, 35])) {
        if (y < zero) orangeAbove++;
        else orangeBelow++;
      }
      if (matches(x, y, [99, 216, 171])) green++;
      if (matches(x, y, [250, 137, 145])) red++;
    }
  }
  ok(
    orangeAbove > 50 && orangeBelow > 50,
    "Benchmark stays orange on both sides of zero",
  );
  ok(
    green > 100 && red > 100,
    "Single portfolio retains green/red performance coloring",
  );
  await Deno.writeFile(
    "/tmp/eyri-benchmark-test.png",
    renderAllTimeDatasets([dataset], benchmark),
  );
});

Deno.test("render cache includes benchmark prices so refreshed quotes redraw the chart", async () => {
  const db = new Database(":memory:");
  try {
    const first = await renderAllTimeChart(db, [dataset], benchmarkCache);
    const next = await renderAllTimeChart(db, [dataset], {
      get: async () => {
        const h = await benchmarkCache.get();
        h.bars[1].close = 110;
        return h;
      },
    });
    ok(!first.every((value, index) => value === next[index]));
    equal(
      (db.prepare("SELECT COUNT(*) AS n FROM alltime_render_cache").get() as {
        n: number;
      }).n,
      2,
    );
  } finally {
    db.close();
  }
});

Deno.test("empty charts fail clearly before native rendering", () => {
  throws(() => renderAllTimeDatasets([]), /No performance points/);
  throws(
    () => renderAllTimeDatasets([{ ...dataset, points: [] }]),
    /No performance points/,
  );
});
