import type { PortfolioChart } from "./portfolio_chart.ts";
import {
  chartColors as colors,
  chartFont,
  renderChart,
} from "./chart_renderer.ts";

export function renderPortfolioAllocation(
  portfolio: PortfolioChart,
): Uint8Array {
  if (!portfolio.holdings.length) throw new Error("No holdings to chart.");
  const width = Math.round(
    Math.max(12, portfolio.holdings.length * 1.25 + 0.8) * 200,
  );
  const heights = portfolio.holdings.map((holding) =>
    holding.change !== null && holding.change < 0
      ? -holding.weight
      : holding.weight,
  );
  const barColors = portfolio.holdings.map((holding) =>
    holding.change === null
      ? colors.muted
      : holding.change >= 0
        ? colors.green
        : colors.red,
  );
  const positiveMax = Math.max(0, ...heights);
  const negativeMax = Math.max(0, ...heights.map((height) => -height));
  const scale = Math.max(positiveMax + negativeMax, 1) / 50;
  const rawStep = Math.max(positiveMax + negativeMax, 1) / 5;
  const magnitude = 10 ** Math.floor(Math.log10(rawStep));
  const step =
    ([1, 2, 5, 10].find((factor) => factor * magnitude >= rawStep) ?? 10) *
    magnitude;
  return renderChart(width, 1600, {
    type: "bar",
    data: {
      labels: portfolio.holdings.map((holding) => holding.ticker),
      datasets: [
        {
          data: heights,
          backgroundColor: barColors,
          borderRadius: 48,
          borderSkipped: "start",
          barPercentage: 0.48,
          categoryPercentage: 1,
        },
      ],
    },
    options: {
      layout: { padding: { left: 120, right: 90, top: 380, bottom: 395 } },
      plugins: { legend: { display: false }, tooltip: { enabled: false } },
      scales: {
        x: { display: false },
        y: {
          min: -negativeMax - 10 * scale,
          max: positiveMax + 10 * scale,
          border: { display: false },
          grid: {
            color: ({ tick }) =>
              tick.value === 0 ? colors.baseline : colors.grid,
            lineWidth: ({ tick }) => (tick.value === 0 ? 2.6 : 1.5),
            drawTicks: false,
          },
          afterBuildTicks: (axis) => {
            const lower = Math.ceil((-negativeMax - 3 * scale) / step);
            const upper = Math.floor((positiveMax + 3 * scale) / step);
            axis.ticks = Array.from(
              { length: upper - lower + 1 },
              (_, index) => ({ value: (lower + index) * step }),
            );
          },
          ticks: {
            color: colors.muted,
            font: { family: chartFont, size: 32 },
            padding: 24,
            callback: (value) =>
              Number(value) === 0 ? "0" : `${Math.abs(Number(value))}%`,
          },
        },
      },
    },
    plugins: [
      {
        id: "portfolioLabels",
        afterDraw(chart) {
          const { ctx, chartArea } = chart;
          const text = (
            label: string,
            x: number,
            y: number,
            size: number,
            color: string,
            bold = false,
            maxWidth?: number,
          ) => {
            ctx.font = `${bold ? "bold " : ""}${size}px ${chartFont}`;
            ctx.fillStyle = color;
            if (maxWidth === undefined) ctx.fillText(label, x, y);
            else ctx.fillText(label, x, y, maxWidth);
          };
          ctx.save();
          ctx.textBaseline = "middle";
          text("STOCK ALLOCATION", chartArea.left, 100, 32, colors.muted, true);
          text(
            portfolio.total,
            chartArea.left,
            210,
            80,
            colors.foreground,
            true,
          );
          const count = portfolio.holdingsCount;
          text(
            `${count} ${count === 1 ? "holding" : "holdings"}  ·  Allocation by market value`,
            chartArea.left,
            285,
            32,
            colors.muted,
          );
          ctx.strokeStyle = "#2C3A48";
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.moveTo(chartArea.left, 1260);
          ctx.lineTo(chartArea.right, 1260);
          ctx.stroke();
          ctx.textAlign = "center";
          const columnWidth = chartArea.width / portfolio.holdings.length;
          chart.getDatasetMeta(0).data.forEach((bar, index) => {
            const holding = portfolio.holdings[index];
            const direction = heights[index] >= 0 ? -1 : 1;
            text(
              `${Number(holding.weight.toFixed(1))}%`,
              bar.x,
              bar.y + direction * 38,
              48,
              colors.foreground,
              true,
              columnWidth - 12,
            );
            text(
              holding.value,
              bar.x,
              bar.y + direction * 92,
              36,
              colors.muted,
              false,
              columnWidth - 12,
            );
            text(
              holding.ticker,
              bar.x,
              1330,
              40,
              colors.foreground,
              true,
              columnWidth - 12,
            );
            text(
              holding.returnLabel,
              bar.x,
              1405,
              40,
              barColors[index],
              true,
              columnWidth - 12,
            );
            text(
              holding.changeLabel,
              bar.x,
              1480,
              36,
              barColors[index],
              false,
              columnWidth - 12,
            );
          });
          ctx.restore();
        },
      },
    ],
  });
}
