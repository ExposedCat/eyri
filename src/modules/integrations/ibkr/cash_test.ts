import { deepStrictEqual, equal, ok } from "node:assert/strict";
import type { IntegrationAccountPerformance, IntegrationOrder } from "../types.ts";
import { reconcileIbkrPendingCash } from "./cash.ts";

const now = new Date("2026-11-06T12:00:00Z");
const account: IntegrationAccountPerformance = {
  integrationId: 1, currency: "USD", totalValue: 299, cash: 99, ledgerCash: { USD: 99 },
  statementCash: { USD: 0 }, historyThrough: new Date("2026-11-05"), openedAt: new Date("2026-01-01"),
  deposits: 100, withdrawals: 0, netContributions: 100, pnl: 199, positionValue: 200, investmentValue: 200,
  fundingHistory: [{ date: "2026-01-01", amount: 100 }],
  cashHistory: [{ date: "2026-01-01", currency: "USD", amount: 100, type: "Deposit" }],
};
const buy: IntegrationOrder = { integrationId: 1, integrationKind: "ibkr", account: "U1", ticker: "A",
  currency: "USD", quantity: 10, price: 10, assetCategory: "STK", date: now,
  commission: { currency: "USD", amount: -1 } };

Deno.test("same-day cash credits are neutralized after replaying executions, never included in profit", async () => {
  const result = await reconcileIbkrPendingCash(account, [buy], now);
  equal(result.pendingCashAdjustment?.amount, 200);
  equal(result.deposits, 300);
  equal(result.pnl, -1);
  equal(result.totalValue, 299);
  equal(result.fundingProvisional, true);
  deepStrictEqual(result.fundingHistory?.at(-1), { date: "2026-11-06", amount: 200, provisional: true });
  equal(account.deposits, 100);
  equal(account.cashHistory?.length, 1);
});

Deno.test("purchases using existing cash and FX conversions are not counted as new funding", async () => {
  const existing = await reconcileIbkrPendingCash({ ...account, deposits: 300, netContributions: 300, statementCash: { USD: 200 } }, [buy], now);
  equal(existing.pendingCashAdjustment?.amount, 0);
  equal(existing.deposits, 300);
  equal(existing.pnl, -1);
  const fx = await reconcileIbkrPendingCash({ ...account, statementCash: { EUR: 100 }, ledgerCash: { EUR: 0, USD: 109 } },
    [{ ...buy, ticker: "EUR.USD", quantity: -100, price: 1.1, assetCategory: "CASH" }], now);
  equal(fx.pendingCashAdjustment?.amount, 0);
});

Deno.test("unclassified native cash is converted into account currency and replaced by completed statements", async () => {
  const request: typeof fetch = () => Promise.resolve(Response.json({ base: "USD", quote: "EUR", rate: .8 }));
  const result = await reconcileIbkrPendingCash({ ...account, currency: "EUR", statementCash: { USD: 0 }, ledgerCash: { USD: 200 } }, [], now, request);
  equal(result.pendingCashAdjustment?.amount, 160);
  equal(result.deposits, 260);
  const completed = { ...account, historyThrough: now, statementCash: { USD: 99 } };
  equal(await reconcileIbkrPendingCash(completed, [buy], now), completed);
  const gift = await reconcileIbkrPendingCash({ ...completed, historyThrough: new Date("2026-11-05") },
    [{ ...buy, receipt: "gift", commission: { amount: 0, currency: "USD" } }], now);
  equal(gift.pendingCashAdjustment?.amount, 0);
  ok(!gift.fundingHistory?.some(flow => flow.provisional));
});

Deno.test("pending withdrawals do not become losses and completed income replaces its provisional funding", async () => {
  const withdrawn = await reconcileIbkrPendingCash({ ...account, totalValue: 50, cash: 50,
    statementCash: { USD: 100 }, ledgerCash: { USD: 50 } }, [], now);
  equal(withdrawn.withdrawals, 50);
  equal(withdrawn.pnl, 0);
  const pendingIncome = await reconcileIbkrPendingCash({ ...account, totalValue: 110, cash: 110,
    statementCash: { USD: 100 }, ledgerCash: { USD: 110 } }, [], now);
  equal(pendingIncome.pnl, 0);
  const classified = { ...account, totalValue: 110, cash: 110, pnl: 10,
    statementCash: { USD: 110 }, ledgerCash: { USD: 110 }, historyThrough: now };
  const completed = await reconcileIbkrPendingCash(classified, [], now);
  equal(completed.pnl, 10);
  equal(completed.deposits, 100);
  equal(completed.pendingCashAdjustment, undefined);
});
