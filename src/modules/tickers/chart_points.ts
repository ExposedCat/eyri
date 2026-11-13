import { UserFacingError } from "../../utils/user_error.ts";

export type ChartPoint = { date: string; percentage: number | null; gain: number | null };

export function chartUsesPercentages(datasets: { kind?: string; points: ChartPoint[] }[]) {
  return datasets.length > 0 && datasets[0]?.kind !== "worth" && datasets.every(dataset =>
    dataset.points.some(point => point.percentage !== null && Number.isFinite(point.percentage)));
}

export function chartComparisonNotes(datasets: { kind?: string; label: string; points: ChartPoint[] }[]) {
  if (datasets.length < 2 || datasets[0].kind === "worth" || chartUsesPercentages(datasets)) return [];
  const missing = datasets.filter(dataset => !dataset.points.some(point => chartPointValue(point, true) !== null));
  return missing.length ? [`Comparing P/L in USD; no percentages for ${missing.map(dataset => dataset.label).join(", ")}.`] : [];
}

export function requireVisibleChart(datasets: { kind?: string; label: string; points: ChartPoint[]; notes?: string[] }[]) {
  const percent = chartUsesPercentages(datasets);
  const missing = datasets.find(dataset => !dataset.points.some(point => chartPointValue(point, percent) !== null));
  if (missing) throw new UserFacingError(`${missing.label}: no usable ${percent ? "percentages" : "values"} in this period. ${
    missing.notes?.find(note => !note.startsWith("Index hidden:")) ?? "Refresh /chart after data sync."}`);
}

export function chartPointValue(point: ChartPoint, percent: boolean, rate = 1): number | null {
  const value = percent ? point.percentage : point.gain === null ? null : point.gain * rate;
  return value !== null && Number.isFinite(value) ? value : null;
}
