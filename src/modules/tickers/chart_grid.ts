export function percentageGrid(values: Iterable<number | null>, intervals = 22) {
  let low = 0, high = 0;
  for (const value of values) if (value !== null && Number.isFinite(value)) {
    low = Math.min(low, value); high = Math.max(high, value);
  }
  if (low === high) { low = -1; high = 1; }
  const span = high - low;
  const padding = span * .05;
  low -= padding; high += padding;
  const desired = (high - low) / intervals;
  const magnitude = 10 ** Math.floor(Math.log10(desired));
  const step = Math.max(1e-8, [1, 2, 2.5, 5, 10].find(factor => factor * magnitude >= desired)! * magnitude);
  const min = Math.floor(low / step) * step, max = Math.ceil(high / step) * step;
  const minorStep = step / 2;
  const ticks = Array.from({ length: Math.round((max - min) / minorStep) + 1 }, (_, index) => ({
    value: Number((min + index * minorStep).toPrecision(12)), major: index % 2 === 0,
  }));
  return { min, max, step, ticks };
}

export function percentageGridLabel(value: number) {
  return `${new Intl.NumberFormat("en-US", { maximumFractionDigits: 8 }).format(value === 0 ? 0 : value)}%`;
}
