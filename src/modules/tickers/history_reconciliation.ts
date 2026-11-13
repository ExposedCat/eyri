import { UserFacingError } from "../../utils/user_error.ts";

export class HistoryMismatchError extends UserFacingError {
  constructor(message: string, detail: string) {
    super(message, { detail, code: "history_mismatch" });
    this.name = "HistoryMismatchError";
  }
}

export function isHistoryMismatch(error: unknown): boolean {
  if (error instanceof AggregateError) return error.errors.some(isHistoryMismatch);
  if (error instanceof Error && error.cause && isHistoryMismatch(error.cause)) return true;
  return error instanceof HistoryMismatchError || error instanceof Error &&
    /Historical quantity does not reconcile|Purchase history missing for sale|Missing purchase history for Trading 212 sale|Bucket (?:holding .*absent|quantity .*exceeds)/.test(error.message);
}

export async function reconcileHistory<T>(load: (refresh: boolean) => Promise<T>): Promise<T> {
  try { return await load(false); }
  catch (error) {
    if (!isHistoryMismatch(error)) throw error;
    return await load(true);
  }
}
