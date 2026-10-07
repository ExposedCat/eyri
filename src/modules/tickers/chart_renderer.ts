import { createCanvas } from "@napi-rs/canvas";
import {
  Chart,
  type ChartConfiguration,
  type ChartOptions,
  type ChartType,
  registerables,
} from "chart.js";

Chart.register(...registerables);

export const chartColors = {
  background: "#101820",
  foreground: "#F3F6F9",
  muted: "#B1BFCE",
  grid: "#24313F",
  baseline: "#8494A6",
  green: "#63D8AB",
  red: "#FA8991",
};
export const chartFont = "DejaVu Sans, Noto Sans, sans-serif";

export function renderChart<T extends ChartType>(
  width: number,
  height: number,
  config: ChartConfiguration<T>,
): Uint8Array {
  const canvas = createCanvas(width, height);
  const chart = new Chart<T>(canvas as unknown as HTMLCanvasElement, {
    ...config,
    options: {
      responsive: false,
      animation: false,
      devicePixelRatio: 1,
      events: [],
      color: chartColors.muted,
      font: { family: chartFont, size: 32 },
      ...config.options,
    } as ChartOptions<T>,
    plugins: [
      {
        id: "background",
        beforeDraw({ ctx }) {
          ctx.save();
          ctx.fillStyle = chartColors.background;
          ctx.fillRect(0, 0, width, height);
          ctx.restore();
        },
      },
      ...(config.plugins ?? []),
    ],
  });
  try {
    return new Uint8Array(canvas.toBuffer("image/png"));
  } finally {
    chart.destroy();
  }
}
