export type PriceBar = { date: string; close: number };
export type StockSplit = { date: string; ratio: number };
export type PriceHistory = {
  symbol: string;
  currency: string;
  bars: PriceBar[];
  splits: StockSplit[];
  instrumentType?: string;
  priceBasis?: "BID";
};
export type Range = { start: string; end: string };
const DAY = 86_400_000;
export const dayAfter = (date: string, days = 1) =>
  new Date(Date.parse(date) + days * DAY).toISOString().slice(0, 10);

export function missingRanges(
  start: string,
  end: string,
  covered: Range[],
): Range[] {
  let cursor = start;
  const missing: Range[] = [];
  for (
    const range of [...covered].sort((a, b) => a.start.localeCompare(b.start))
  ) {
    if (range.end <= cursor || range.start >= end) continue;
    if (range.start > cursor) {
      missing.push({
        start: cursor,
        end: range.start < end ? range.start : end,
      });
    }
    if (range.end > cursor) cursor = range.end;
  }
  if (cursor < end) missing.push({ start: cursor, end });
  return missing;
}
