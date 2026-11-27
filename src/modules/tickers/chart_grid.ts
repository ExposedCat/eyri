const MIN_PERCENTAGE = -100;

export function percentageGrid(values: Iterable<number | null>, intervals = 22) {
  let low = 0, high = 0;
  for (const value of values) if (value !== null && Number.isFinite(value)) {
    low = Math.min(low, value); high = Math.max(high, value);
  }
  low = Math.max(MIN_PERCENTAGE, low);
  if (low === high) { low = -1; high = 1; }
  const span = high - low;
  const padding = span * .05;
  low = Math.max(MIN_PERCENTAGE, low - padding);
  high += padding;
  const desired = (high - low) / intervals;
  const magnitude = 10 ** Math.floor(Math.log10(desired));
  const step = Math.max(1e-8, [1, 2, 2.5, 5, 10].find(factor => factor * magnitude >= desired)! * magnitude);
  const minIndex = Math.floor(low / step);
  const maxIndex = Math.ceil(high / step);
  const clamped = minIndex * step < MIN_PERCENTAGE;
  const min = clamped ? MIN_PERCENTAGE : Number((minIndex * step).toPrecision(12));
  const max = Number((maxIndex * step).toPrecision(12));
  const minorStep = step / 2;
  const firstTick = clamped ? Math.ceil(min / minorStep - 1e-9) : minIndex * 2;
  const lastTick = maxIndex * 2;
  const ticks = Array.from({ length: lastTick - firstTick + 1 }, (_, index) => {
    const tick = firstTick + index;
    return {
      value: Number((tick * minorStep).toPrecision(12)), major: tick % 2 === 0,
    };
  });
  return { min, max, step, ticks };
}

export function percentageGridLabel(value: number) {
  return `${new Intl.NumberFormat("en-US", { maximumFractionDigits: 8 }).format(value === 0 ? 0 : value)}%`;
}
