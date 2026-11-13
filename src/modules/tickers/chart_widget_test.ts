import { deepStrictEqual, equal, match, ok, throws } from "node:assert/strict";
import { runInNewContext } from "node:vm";
import { deflateSync } from "node:zlib";
import type { AllTimeDataset } from "./alltime_chart.ts";
import type { ChartBenchmark } from "./chart_benchmark.ts";
import { renderChartWidget } from "./chart_widget.ts";

function fixture(length = 3) {
  const points = Array.from({ length }, (_, i) => ({
    date: new Date(Date.UTC(2024, 0, 1 + i)).toISOString().slice(0, 10),
    percentage: i * 1.25,
    gain: i * 100.12,
  }));
  const dataset: AllTimeDataset = {
    fundingReturnVersion: 6,
    kind: "alltime",
    userId: 1,
    label: "Portfolio",
    bucketName: null,
    points,
  };
  const benchmark = (symbol: string, factor: number): ChartBenchmark => ({
    symbol,
    label: symbol,
    asOf: points.at(-1)!.date,
    points: points.map((point) => ({
      ...point,
      percentage: point.percentage * factor,
      gain: point.gain * factor,
    })),
  });
  return {
    dataset,
    sp500: benchmark("CSPX.L", .5),
    iumo: benchmark("IUMO.L", 1.5),
  };
}

function runWidget(html: string) {
  class Element {
    textContent = "";
    children: Element[] = [];
    attributes: Record<string, string> = {};
    listeners: Record<string, () => void> = {};
    classList = { toggle: (_name: string, _active: boolean) => {} };
    set innerHTML(_html: string) {
      this.children = [];
    }
    setAttribute(name: string, value: string) {
      this.attributes[name] = String(value);
    }
    appendChild(child: Element) {
      this.children.push(child);
    }
    addEventListener(event: string, listener: () => void) {
      this.listeners[event] = listener;
    }
  }
  const elements = new Map<string, Element>();
  const get = (id: string) => {
    if (!elements.has(id)) elements.set(id, new Element());
    return elements.get(id)!;
  };
  runInNewContext(html.match(/<script>([\s\S]*)<\/script>/)![1], {
    document: { getElementById: get, createElementNS: () => new Element() },
  });
  return get;
}

Deno.test("widget selector switches benchmark paths and values locally and preserves the portfolio", () => {
  const { dataset, sp500, iumo } = fixture();
  const get = runWidget(renderChartWidget(dataset, sp500, iumo));
  const paths = () => get("plot").children.filter((node) => node.attributes.d);
  equal(get("benchmarkName").textContent, "If CSPX.L");
  equal(get("benchmarkValue").textContent, "1.25%");
  equal(get("actual").textContent, "2.50%");
  const original = paths().map((path) => path.attributes.d);
  get("iumo").listeners.click();
  equal(get("benchmarkName").textContent, "If IUMO.L");
  equal(get("benchmarkValue").textContent, "3.75%");
  equal(get("actual").textContent, "2.50%");
  ok(paths()[0].attributes.d !== original[0]);
  get("sp500").listeners.click();
  deepStrictEqual(paths().map((path) => path.attributes.d), original);
});

Deno.test("widget escapes user text and shows monetary views in the preferred currency", () => {
  const { dataset, sp500, iumo } = fixture();
  dataset.kind = "worth";
  dataset.label = '</script><script>throw Error("injected")</script>';
  dataset.notes = ["<img src=x onerror=alert(1)>"];
  dataset.displayCurrency = "EUR";
  dataset.displayRate = .8;
  const html = renderChartWidget(dataset, sp500, iumo);
  equal((html.match(/<script>/g) ?? []).length, 1);
  const get = runWidget(html);
  equal(get("title").textContent, `${dataset.label} · worth`);
  equal(get("notes").textContent, dataset.notes[0]);
  match(get("actual").textContent, /160[.,]19/);
  ok(!get("actual").textContent.includes("%"));
});

Deno.test("widget handles single-point and missing-percentage histories without invalid SVG", () => {
  const { dataset, sp500, iumo } = fixture(1);
  dataset.points[0].percentage = null;
  const get = runWidget(renderChartWidget(dataset, sp500, iumo));
  ok(!get("actual").textContent.includes("%"));
  for (const element of get("plot").children) {
    ok(!JSON.stringify(element.attributes).match(/NaN|Infinity/));
  }
});

Deno.test("widget retains the percentage axis and draws separate paths across missing dates", () => {
  const { dataset, sp500, iumo } = fixture(5);
  dataset.points[2] = { ...dataset.points[2], gain: null, percentage: null };
  const get = runWidget(renderChartWidget(dataset, sp500, iumo));
  equal(get("actual").textContent, "5.00%");
  const paths = get("plot").children.filter(node => node.attributes.d);
  ok(paths.some(node => (node.attributes.d.match(/M/g) ?? []).length === 2));
  for (const element of get("plot").children) ok(!JSON.stringify(element.attributes).match(/NaN|Infinity/));
});

Deno.test("widget marks actual purchases and only the index endpoint", () => {
  const { dataset, sp500, iumo } = fixture(5);
  dataset.purchaseDates = [dataset.points[1].date, dataset.points[3].date];
  const get = runWidget(renderChartWidget(dataset, sp500, iumo));
  const circles = get("plot").children.filter(node => node.attributes.cx !== undefined);
  equal(circles.filter(node => node.attributes.stroke === "#e7c678").length, 1);
  equal(circles.filter(node => node.attributes.stroke === "#59d6ad").length, 3);
  const originalMain = circles.filter(node => node.attributes.stroke === "#59d6ad").map(node => node.attributes.cx);
  get("iumo").listeners.click();
  // Changing the index can rescale the y axis; purchase dates stay fixed.
  deepStrictEqual(get("plot").children.filter(node => node.attributes.stroke === "#59d6ad" && node.attributes.cx !== undefined).map(node => node.attributes.cx), originalMain);
});

Deno.test("widget percentage grid uses more than four round labels with faint intermediate lines", () => {
  const { dataset, sp500, iumo } = fixture(5);
  const get = runWidget(renderChartWidget(dataset, sp500, iumo));
  const labels = get("plot").children.filter(node => node.textContent.endsWith("%"));
  ok(labels.length >= 6 && labels.length <= 14);
  ok(labels.some(node => node.textContent === "0%"));
  const lines = get("plot").children.filter(node => node.attributes.x2 === "350");
  ok(lines.length > labels.length);
  ok(lines.some(node => node.attributes["stroke-opacity"] === ".1"));
});

Deno.test("long widget histories fit Telegram limits, retain endpoints and leave missing benchmark data as gaps", () => {
  const { dataset, sp500, iumo } = fixture(7300);
  dataset.points.forEach((point, i) => {
    point.percentage = Math.sin(i * 134.1) * 40;
  });
  const html = renderChartWidget(dataset, sp500, iumo);
  ok(new TextEncoder().encode(html).length <= 32768);
  ok(deflateSync(html, { level: 9 }).length <= 4096);
  match(html, new RegExp(dataset.points[0].date));
  match(html, new RegExp(dataset.points.at(-1)!.date));
  sp500.points.pop();
  const get = runWidget(renderChartWidget(dataset, sp500, iumo));
  equal(get("benchmarkValue").textContent, "Value unavailable");
});
