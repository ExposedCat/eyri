import { UserFacingError } from "./user_error.ts";
export function requireReportNumber(
  value: number | null | undefined,
  field: string,
): number {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    throw new UserFacingError(`${field} ${value == null ? "is missing" : `is ${value}`}. Retry; if unchanged, ask admin.`,
      { detail: `Cannot build report: ${field} is unavailable.` });
  }
  return value;
}
