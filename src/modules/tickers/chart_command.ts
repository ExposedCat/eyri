import type { AllTimeDataset } from "./alltime_chart.ts";
import { parsePerformanceArgs } from "./performance_command.ts";
import { UserFacingError } from "../../utils/user_error.ts";

export type ChartWindow = { years: number; months: number; weeks: number; days: number };
export const chartUsage = "Use /chart [widget] [1y 2m 3w 4d] [stocks|options] [BUCKET].";

export function parseChartArgs(input: unknown) {
  const parts = typeof input === "string" ? input.trim().split(/\s+/).filter(Boolean) : [];
  const window: ChartWindow = { years: 0, months: 0, weeks: 0, days: 0 };
  const units = { y: "years", m: "months", w: "weeks", d: "days" } as const;
  const seen = new Set<string>(), remaining: string[] = [];
  let widget = false;
  for (const part of parts) {
    const lower = part.toLowerCase();
    if (lower === "widget") { if (widget) return null; widget = true; continue; }
    if (["perf", "dpnl", "worth", "alltime"].includes(lower)) return null;
    if (/^(?:\d+[ymwd])+$/.test(lower)) {
      for (const match of lower.matchAll(/(\d+)([ymwd])/g)) {
        const amount = Number(match[1]), unit = match[2] as keyof typeof units;
        if (!Number.isSafeInteger(amount) || amount <= 0 || seen.has(unit)) return null;
        seen.add(unit); window[units[unit]] = amount;
      }
    } else {
      if (/^\d/.test(lower) || /^[+-]\d/.test(lower)) return null;
      remaining.push(part);
    }
  }
  if (window.years * 366 + window.months * 31 + window.weeks * 7 + window.days > 36600) return null;
  const args = parsePerformanceArgs(remaining.join(" "));
  if (!args || args.filter && args.bucketName && /^(s|o|stocks|options)$/i.test(args.bucketName)) return null;
  return { ...args, widget, window: seen.size ? window : undefined };
}

export function chartWindowStart(end: string, window: ChartWindow) {
  const date = new Date(`${end}T00:00:00Z`), day = date.getUTCDate();
  // Clamp month/year subtraction to the destination month's final day.
  date.setUTCDate(1);
  date.setUTCMonth(date.getUTCMonth() - window.years * 12 - window.months);
  const lastDay = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
  date.setUTCDate(Math.min(day, lastDay));
  date.setUTCDate(date.getUTCDate() - window.weeks * 7 - window.days);
  return date.toISOString().slice(0, 10);
}

// Keep the original contributions, gifts and return basis. A time window crops
// the picture; it does not restart investing or reset lifetime returns to zero.
export function clipChartDataset(dataset: AllTimeDataset, start: string, end: string, dateRange = true): AllTimeDataset {
  const within = (point: { date: string }) => point.date >= start && point.date <= end;
  const points = dataset.points.filter(within);
  if (!points.length) throw new UserFacingError(`${dataset.label}: no history in ${start}–${end}. Choose a longer window.`);
  const clip = (benchmark: NonNullable<AllTimeDataset["benchmark"]>) => ({ ...benchmark, points: benchmark.points.filter(within) });
  const benchmark = dataset.benchmark && clip(dataset.benchmark);
  return { ...dataset, points, ...(dateRange ? { dateRange: { start: points[0].date, end } } : {}),
    ...(dataset.purchaseDates ? { purchaseDates: dataset.purchaseDates.filter(date => date >= start && date <= end) } : {}),
    ...(benchmark ? { benchmark } : {}),
    ...(dataset.benchmarkSnapshots ? { benchmarkSnapshots: Object.fromEntries(Object.entries(dataset.benchmarkSnapshots).map(([key, value]) => [key, clip(value)])) } : {}),
  };
}
