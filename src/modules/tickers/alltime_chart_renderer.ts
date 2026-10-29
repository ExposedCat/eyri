import type { Chart, ChartDataset, ScriptableContext } from "chart.js";
import type { AllTimeDataset } from "./alltime_chart.ts";
import { CHART_BENCHMARKS, chartBenchmarkIndex } from "./chart_benchmark.ts";
import {
  chartColors as colors,
  chartFont,
  renderChart,
} from "./chart_renderer.ts";

const palette = [
  colors.green,
  colors.red,
  "#75C7E8",
  "#B7A0EC",
  "#E7C678",
  colors.foreground,
];
const day = 86_400_000;

export function benchmarkMarkerIndices(
  points: { x: number; y: number }[],
  minimumDistance = 70,
) {
  if (!points.length) return [];
  const turns: number[] = [0];
  let direction = 0;
  for (let index = 1; index < points.length; index++) {
    const nextDirection = Math.sign(points[index].y - points[index - 1].y);
    if (!nextDirection) continue;
    if (direction && nextDirection !== direction) turns.push(index - 1);
    direction = nextDirection;
  }
  const last = points.length - 1;
  if (last === 0 || points[last].x - points[0].x < minimumDistance) return [last];
  turns.push(last);
  const selected = [0, last];
  const candidates = turns.slice(1, -1).map((index, position) => ({
    index,
    prominence: Math.min(
      Math.abs(points[index].y - points[turns[position]].y),
      Math.abs(points[index].y - points[turns[position + 2]].y),
    ),
  })).sort((first, second) => second.prominence - first.prominence);
  for (const { index } of candidates) {
    if (selected.every(previous => Math.abs(points[index].x - points[previous].x) >= minimumDistance)) {
      selected.push(index);
    }
  }
  return selected.sort((first, second) => first - second);
}

function money(value: number, currency: string) {
  const amount = Math.abs(value).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return `${value > 0 ? "+" : value < 0 ? "-" : ""}${
    currency === "USD" ? `$${amount}` : `${amount} ${currency}`
  }`;
}

export function renderAllTimeDatasets(
  datasets: AllTimeDataset[],
): Uint8Array {
  if (
    !datasets.length || datasets.some((dataset) => !dataset.points.length) ||
    datasets.some((dataset) => dataset.benchmark && !dataset.benchmark.points.length)
  ) {
    throw new Error("No performance points to chart.");
  }
  const first = new Date(
    Math.min(...datasets.map((dataset) => Date.parse(dataset.points[0].date))),
  );
  const last = new Date(
    Math.max(
      ...datasets.map((dataset) =>
        Date.parse(dataset.points[dataset.points.length - 1].date)
      ),
    ),
  );
  const months = (last.getUTCFullYear() - first.getUTCFullYear()) * 12 +
    last.getUTCMonth() -
    first.getUTCMonth() +
    1;
  const width = Math.round(
    Math.max(12, Math.min(32, months * 0.6 + 1.4)) * 200,
  );
  const single = datasets.length === 1;
  const percentagesAvailable = datasets.every(dataset => dataset.points.every(point => point.percentage !== null));
  const displayCurrency = single ? (datasets[0].displayCurrency ?? "USD") : "USD";
  const displayRate = single ? (datasets[0].displayRate ?? 1) : 1;
  const monthTicks: { value: number }[] = [];
  for (
    let date = Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), 1);
    date <= +last;
  ) {
    monthTicks.push({ value: date });
    const current = new Date(date);
    date = Date.UTC(current.getUTCFullYear(), current.getUTCMonth() + 1, 1);
  }
  const legendCount = datasets.length + datasets.filter((dataset) => dataset.benchmark).length;
  const legendColumns = legendCount === 1 ? 1 : 2;
  const legendHeight = Math.ceil(legendCount / legendColumns) * 60;
  return renderChart(width, 1400, {
    type: "line",
    data: {
      datasets: [
        ...datasets.map<ChartDataset<"line">>((dataset, index) => ({
          label: dataset.label,
          data: dataset.points.map((point) => ({
            x: Date.parse(point.date),
            y: percentagesAvailable ? point.percentage! : point.gain * displayRate,
          })),
          parsing: false,
          borderColor: palette[index % palette.length],
          borderWidth: 4.4,
          borderCapStyle: "round",
          borderJoinStyle: "round",
          // Preserve every daily value without overshooting between samples.
          cubicInterpolationMode: "monotone",
          pointRadius: ({ dataIndex }: ScriptableContext<"line">) =>
            dataIndex === dataset.points.length - 1 ? 5 : 0,
          pointBorderWidth: 0,
          pointBackgroundColor: palette[index % palette.length],
          fill: false,
        })),
        ...datasets.flatMap<ChartDataset<"line">>((dataset, index) =>
          dataset.benchmark ? [{
            label: `${dataset.label} · ${dataset.benchmark.label}`,
            data: dataset.benchmark.points.map((point) => ({
              x: Date.parse(point.date),
              y: percentagesAvailable ? point.percentage! : point.gain * displayRate,
            })),
            parsing: false as const,
            borderColor: single ? "#E7C678" : palette[index % palette.length],
            order: 1,
            borderWidth: 4.4,
            borderDash: [12, 12],
            borderCapStyle: "round" as const,
            borderJoinStyle: "round" as const,
            // Join actual daily closes directly; no curve smoothing.
            tension: 0,
            pointRadius: 0,
            pointBorderWidth: 0,
            fill: false as const,
          }]
          : []),
      ],
    },
    options: {
      layout: {
        padding: { left: 110, right: 60, top: 70, bottom: 110 + legendHeight },
      },
      plugins: { legend: { display: false }, tooltip: { enabled: false } },
      scales: {
        x: {
          type: "linear",
          min: monthTicks[0].value,
          max: +last + 3 * day,
          afterBuildTicks: (scale) => {
            scale.ticks = monthTicks;
          },
          border: { display: false },
          grid: { color: colors.grid, lineWidth: 1.5, drawTicks: false },
          ticks: {
            color: colors.muted,
            autoSkip: false,
            padding: 24,
            minRotation: months > 60 ? 90 : 0,
            maxRotation: months > 60 ? 90 : 0,
            font: { family: chartFont, size: months > 60 ? 24 : 32 },
            callback: (value) => {
              const date = new Date(Number(value));
              const month = date.toLocaleString("en-US", {
                month: "short",
                timeZone: "UTC",
              });
              return date.getUTCMonth() === 0 ||
                  Number(value) === monthTicks[0].value
                ? [month, String(date.getUTCFullYear())]
                : month;
            },
          },
        },
        y: {
          type: "linear",
          grace: "15%",
          border: { display: false },
          grid: {
            color: ({ tick }) =>
              tick.value === 0 ? colors.baseline : colors.grid,
            lineWidth: ({ tick }) => (tick.value === 0 ? 2 : 1.5),
            drawTicks: false,
          },
          ticks: {
            color: colors.muted,
            font: { family: chartFont, size: 32 },
            padding: 24,
            callback: (value) => percentagesAvailable ? `${value}%` : money(Number(value), displayCurrency),
          },
        },
      },
    },
    plugins: [
      {
        id: "benchmarkTurningPoints",
        afterDatasetsDraw(chart) {
          const { ctx } = chart;
          ctx.save();
          datasets.filter(dataset => dataset.benchmark).forEach((dataset, benchmarkIndex) => {
            const participantIndex = datasets.indexOf(dataset);
            const points = chart.getDatasetMeta(datasets.length + benchmarkIndex).data;
            ctx.strokeStyle = single ? "#E7C678" : palette[participantIndex % palette.length];
            ctx.fillStyle = colors.background;
            ctx.lineWidth = 3.5;
            ctx.setLineDash([]);
            for (const index of benchmarkMarkerIndices(points)) {
              ctx.beginPath();
              ctx.arc(points[index].x, points[index].y, 9, 0, 2 * Math.PI);
              ctx.fill();
              ctx.stroke();
            }
          });
          ctx.restore();
        },
      },
      {
        id: "performanceLegend",
        afterDraw(chart) {
          const { ctx, chartArea } = chart;
          ctx.save();
          ctx.font = `30px ${chartFont}`;
          ctx.textBaseline = "middle";
          const entries = datasets.flatMap((dataset, index) => {
            const last = dataset.points[dataset.points.length - 1];
            const color = palette[index % palette.length];
            const name = dataset.label +
              (dataset.bucketName ? ` / ${dataset.bucketName}` : "");
            const currency = single
              ? (dataset.displayCurrency ?? "USD")
              : "USD";
            const rate = single ? (dataset.displayRate ?? 1) : 1;
            const lifetimeReturn = last.percentage === null ? "Lifetime % unavailable"
              : `${last.percentage >= 0 ? "+" : ""}${last.percentage.toFixed(2)}%`;
            const label = `${name}  ${lifetimeReturn}  (${money(last.gain * rate, currency)})`;
            const entries = [{ color, label, dashed: false }];
            if (dataset.benchmark) {
              const last = dataset.benchmark.points.at(-1)!;
              entries.push({
                color: single ? "#E7C678" : palette[index % palette.length],
                label: `${name} · if ${CHART_BENCHMARKS[chartBenchmarkIndex(dataset.benchmark.symbol)].name}  ${last.percentage >= 0 ? "+" : ""}${
                  last.percentage.toFixed(2)
                }%  (${money(last.gain * rate, currency)})`,
                dashed: true,
              });
            }
            return entries;
          });
          entries.forEach(({ color, label, dashed }, index) => {
            const column = index % legendColumns;
            const row = Math.floor(index / legendColumns);
            const x = chartArea.left +
              column * (chartArea.width / legendColumns);
            const y = chart.height - legendHeight - 38 + row * 60;
            ctx.strokeStyle = color;
            ctx.lineWidth = 4.4;
            ctx.setLineDash(dashed ? [12, 12] : []);
            ctx.beginPath();
            ctx.moveTo(x, y);
            ctx.lineTo(x + 45, y);
            ctx.stroke();
            ctx.fillStyle = colors.foreground;
            ctx.fillText(
              label,
              x + 60,
              y,
              chartArea.width / legendColumns - 80,
            );
          });
          ctx.restore();
        },
      },
    ],
  });
}
