export function requireReportNumber(
  value: number | null | undefined,
  field: string,
): number {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    throw new Error(`Cannot build report: ${field} is unavailable.`);
  }
  return value;
}
