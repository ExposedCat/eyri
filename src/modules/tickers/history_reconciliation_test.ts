import { deepStrictEqual, equal, rejects } from "node:assert/strict";
import { HistoryMismatchError, reconcileHistory } from "./history_reconciliation.ts";

Deno.test("a stale trade history is refreshed once before rebuilding", async () => {
  const attempts: boolean[] = [];
  const result = await reconcileHistory(async refresh => {
    attempts.push(refresh);
    if (!refresh) throw new HistoryMismatchError("A: history 10, broker 5 shares.", "Historical quantity does not reconcile for A");
    return 5;
  });
  equal(result, 5);
  deepStrictEqual(attempts, [false, true]);
});

Deno.test("a mismatch after refresh stays an error with measured quantities", async () => {
  const attempts: boolean[] = [];
  const failure = new HistoryMismatchError("A: history 10, broker 5 shares after refresh. Ask admin.", "Historical quantity does not reconcile for A");
  await rejects(reconcileHistory(async refresh => { attempts.push(refresh); throw failure; }), error => error === failure);
  deepStrictEqual(attempts, [false, true]);
});

Deno.test("wrapped importer mismatches trigger refresh but unrelated failures do not", async () => {
  const attempts: boolean[] = [];
  await reconcileHistory(async refresh => {
    attempts.push(refresh);
    if (!refresh) throw new AggregateError([new Error("Purchase history missing for sale of A")]);
  });
  deepStrictEqual(attempts, [false, true]);
  let calls = 0;
  await rejects(reconcileHistory(async () => { calls++; throw new Error("request timed out"); }), /timed out/);
  equal(calls, 1);
});
