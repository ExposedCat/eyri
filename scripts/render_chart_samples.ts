// Run: deno run -A scripts/render_chart_samples.ts [output-directory]
// These previews use deterministic sample data, not broker account data.
import { renderAllTimeDatasets } from "../src/modules/tickers/alltime_chart_renderer.ts";
import type { AllTimeDataset } from "../src/modules/tickers/alltime_chart.ts";
import { renderPortfolioChart } from "../src/modules/tickers/portfolio_chart.ts";

const directory = Deno.args[0] ?? "/tmp/eyri-chart-previews";
await Deno.mkdir(directory, { recursive: true });
const start = Date.UTC(2025, 9, 1);
let randomState = 42;
let noise = 0;
const points = Array.from({ length: 373 }, (_, index) => {
  randomState ^= randomState << 13;
  randomState ^= randomState >>> 17;
  randomState ^= randomState << 5;
  noise = noise * 0.82 + ((randomState >>> 0) / 4_294_967_296 - 0.5) * 1.4;
  const percentage =
    (index / 372) * 22 +
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
await Deno.writeFile(
  `${directory}/alltime.png`,
  renderAllTimeDatasets([portfolio]),
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
  ]),
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
