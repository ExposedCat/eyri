// Run: deno run -A scripts/render_chart_samples.ts [output-directory] [--live-benchmark]
// Portfolios are deterministic samples, never broker account data. The optional
// live-benchmark flag uses real CSPX.L closes instead of a labeled sample curve.
import { renderAllTimeDatasets } from "../src/modules/tickers/alltime_chart_renderer.ts";
import type { AllTimeDataset } from "../src/modules/tickers/alltime_chart.ts";
import { renderPortfolioChart } from "../src/modules/tickers/portfolio_chart.ts";
import { buildChartBenchmark } from "../src/modules/tickers/chart_benchmark.ts";
import {
  dayAfter,
  fetchYahooHistory,
} from "../src/modules/market_data/yahoo.ts";

const directory = Deno.args.find((arg) => !arg.startsWith("--")) ??
  "/tmp/eyri-chart-previews";
await Deno.mkdir(directory, { recursive: true });
const start = Date.UTC(2025, 9, 1);
let randomState = 42;
let noise = 0;
const points = Array.from({ length: 373 }, (_, index) => {
  randomState ^= randomState << 13;
  randomState ^= randomState >>> 17;
  randomState ^= randomState << 5;
  noise = noise * 0.82 + ((randomState >>> 0) / 4_294_967_296 - 0.5) * 1.4;
  const percentage = (index / 372) * 22 +
    Math.sin(index / 23) * 8 +
    Math.sin(index / 8) * 2 +
    noise -
    5;
  return {
    date: new Date(start + index * 86_400_000).toISOString().slice(0, 10),
    percentage,
    gain: percentage * 950,
  };
});
const portfolio: AllTimeDataset = {
  userId: 0,
  label: "Sample portfolio",
  bucketName: null,
  points,
};
const benchmark = Deno.args.includes("--live-benchmark")
  ? buildChartBenchmark(
    await fetchYahooHistory(
      "CSPX.L",
      dayAfter(points[0].date, -7),
      dayAfter(points.at(-1)!.date),
    ),
    points[0].date,
    points.at(-1)!.date,
  )
  : {
    label: "Sample S&P 500 (CSPX.L)",
    symbol: "CSPX.L",
    asOf: points.at(-1)!.date,
    points: points.map((point, index) => ({
      date: point.date,
      percentage: index / 372 * 14 + Math.sin(index / 42) * 3,
    })),
  };
await Deno.writeFile(
  `${directory}/alltime.png`,
  renderAllTimeDatasets([portfolio], benchmark),
);
await Deno.writeFile(
  `${directory}/comparison.png`,
  renderAllTimeDatasets([
    portfolio,
    {
      ...portfolio,
      userId: 1,
      label: "Sample comparison",
      points: points.map((point, index) => ({
        ...point,
        percentage: (index / 372) * 12 + Math.sin(index / 35) * 4,
        gain: ((index / 372) * 12 + Math.sin(index / 35) * 4) * 700,
      })),
    },
  ], benchmark),
);
await Deno.writeFile(
  `${directory}/portfolio.png`,
  await renderPortfolioChart({
    total: "$100,000.00",
    holdingsCount: 7,
    holdings: [
      {
        ticker: "NVDA",
        weight: 28,
        value: "$28,000",
        change: 8000,
        returnLabel: "+40.0%",
        changeLabel: "+$8,000.00",
      },
      {
        ticker: "MSFT",
        weight: 22,
        value: "$22,000",
        change: -2000,
        returnLabel: "-8.3%",
        changeLabel: "-$2,000.00",
      },
      {
        ticker: "AAPL",
        weight: 17,
        value: "$17,000",
        change: 2000,
        returnLabel: "+13.3%",
        changeLabel: "+$2,000.00",
      },
      {
        ticker: "GOOGL",
        weight: 12,
        value: "$12,000",
        change: 2000,
        returnLabel: "+20.0%",
        changeLabel: "+$2,000.00",
      },
      {
        ticker: "TSLA",
        weight: 9,
        value: "$9,000",
        change: -2000,
        returnLabel: "-18.2%",
        changeLabel: "-$2,000.00",
      },
      {
        ticker: "AMZN",
        weight: 7,
        value: "$7,000",
        change: 1000,
        returnLabel: "+16.7%",
        changeLabel: "+$1,000.00",
      },
      {
        ticker: "DIS",
        weight: 5,
        value: "$5,000",
        change: -1000,
        returnLabel: "-16.7%",
        changeLabel: "-$1,000.00",
      },
    ],
  }),
);
console.log(`Rendered sample charts in ${directory}`);
