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
    fundingReturnVersion: 3,
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
    spyl: benchmark("SPYL.L", .5),
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
  const { dataset, spyl, iumo } = fixture();
  const get = runWidget(renderChartWidget(dataset, spyl, iumo));
  const paths = () => get("plot").children.filter((node) => node.attributes.d);
  equal(get("benchmarkName").textContent, "If SPYL.L");
  equal(get("benchmarkValue").textContent, "1.25%");
  equal(get("actual").textContent, "2.50%");
  const original = paths().map((path) => path.attributes.d);
  get("iumo").listeners.click();
  equal(get("benchmarkName").textContent, "If IUMO.L");
  equal(get("benchmarkValue").textContent, "3.75%");
  equal(get("actual").textContent, "2.50%");
  ok(paths()[0].attributes.d !== original[0]);
  get("spyl").listeners.click();
  deepStrictEqual(paths().map((path) => path.attributes.d), original);
});

Deno.test("widget escapes user text and shows monetary views in the preferred currency", () => {
  const { dataset, spyl, iumo } = fixture();
  dataset.kind = "worth";
  dataset.label = '</script><script>throw Error("injected")</script>';
  dataset.notes = ["<img src=x onerror=alert(1)>"];
  dataset.displayCurrency = "EUR";
  dataset.displayRate = .8;
  const html = renderChartWidget(dataset, spyl, iumo);
  equal((html.match(/<script>/g) ?? []).length, 1);
  const get = runWidget(html);
  equal(get("title").textContent, `${dataset.label} · worth`);
  equal(get("notes").textContent, dataset.notes[0]);
  match(get("actual").textContent, /160[.,]19/);
  ok(!get("actual").textContent.includes("%"));
});

Deno.test("widget handles single-point and missing-percentage histories without invalid SVG", () => {
  const { dataset, spyl, iumo } = fixture(1);
  dataset.points[0].percentage = null;
  const get = runWidget(renderChartWidget(dataset, spyl, iumo));
  ok(!get("actual").textContent.includes("%"));
  for (const element of get("plot").children) {
    ok(!JSON.stringify(element.attributes).match(/NaN|Infinity/));
  }
});

Deno.test("long widget histories fit Telegram limits, retain endpoints and reject incomplete data", () => {
  const { dataset, spyl, iumo } = fixture(7300);
  dataset.points.forEach((point, i) => {
    point.percentage = Math.sin(i * 134.1) * 40;
  });
  const html = renderChartWidget(dataset, spyl, iumo);
  ok(new TextEncoder().encode(html).length <= 32768);
  ok(deflateSync(html, { level: 9 }).length <= 4096);
  match(html, new RegExp(dataset.points[0].date));
  match(html, new RegExp(dataset.points.at(-1)!.date));
  spyl.points.pop();
  throws(() => renderChartWidget(dataset, spyl, iumo), /incomplete/);
});
