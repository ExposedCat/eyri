import { deepStrictEqual, equal, ok } from "node:assert/strict";
import type { IntegrationAccountPerformance, IntegrationOrder } from "../integrations/types.ts";
import { accountFxInputs, accountFxPnl, accountTopups, proportionalCurrencyReturns } from "./account_fx.ts";
import { buildIntegratedAllTimeReport, buildIntegratedAllTimePerformanceList } from "./portfolio.ts";
import { buildTrading212Ledger } from "../integrations/trading212/ledger.ts";
import { buildHistoricalReportSeries } from "./historical_report.ts";
import { buildReportSnapshot } from "./report.ts";

const rates = new Map([["USD", 1], ["CZK", .05], ["EUR", 1.25]]);
const account: IntegrationAccountPerformance = {
  integrationId: 1, currency: "CZK", totalValue: 20000, deposits: 25000, withdrawals: 0,
  netContributions: 25000, cash: 0, ledgerCash: { CZK: 0, USD: 0 }, pnl: -5000,
  positionValue: 20000, investmentValue: 20000, openedAt: new Date("2025-01-01"),
  historyThrough: new Date("2025-01-03"), reportedComponents: [{ currency: "USD", cost: 1000, pnl: 0 }],
  fundingHistory: [{ date: "2025-01-01", amount: 25000 }],
  cashHistory: [{ date: "2025-01-01", currency: "CZK", amount: 25000, type: "Deposit" }],
};
const conversion: IntegrationOrder = { integrationId: 1, integrationKind: "ibkr", account: "A",
  ticker: "USD.CZK", currency: "CZK", quantity: 1000, price: 25, assetCategory: "CASH",
  date: new Date("2025-01-02"), commission: { currency: "CZK", amount: -1 } };
const near = (actual: number, expected: number) => ok(Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`);
const fx = (a: IntegrationAccountPerformance, orders: IntegrationOrder[] = []) =>
  accountFxPnl(accountFxInputs([a], orders), rates)[0];

Deno.test("holding a top-up currency creates no FX income even when the broker uses another base currency", () => {
  const cash = { ...account, totalValue: 25000, positionValue: 0, cash: 25000, ledgerCash: { CZK: 25000 } };
  near(fx(cash).pnl, 0);
  const foreignCash = { ...cash, cashHistory: [{ date: "2025-01-01", currency: "USD", amount: 1000, type: "Deposit" }] };
  // USD was the original top-up currency; a CZK broker base must not invent
  // a currency loss on untouched dollars.
  near(fx(foreignCash).pnl, 0);
  const usdAccount = { ...cash, currency: "USD", deposits: 1000, withdrawals: 0,
    fundingHistory: [{ date: "2025-01-01", amount: 1000 }], cashHistory: foreignCash.cashHistory };
  near(fx(usdAccount).pnl, 0);
});

Deno.test("hypothetical CZK liquidation combines stock performance with currency movement", () => {
  const current = new Map([["USD", 1], ["CZK", 1 / 27]]);
  const currencyPnl = accountFxPnl(accountFxInputs([account], [conversion]), current)[0].pnl;
  const [flatStock] = proportionalCurrencyReturns(accountTopups([account]), currencyPnl, current);
  near(flatStock.saleProceeds, 27000);
  near(flatStock.pnl, 2000);
  near(flatStock.percentage!, 8);
  const [growingStock] = proportionalCurrencyReturns(accountTopups([account]), 100 + currencyPnl, current);
  near(growingStock.saleProceeds, 29700);
  near(growingStock.pnl, 4700);
  near(growingStock.percentage!, 18.8);
});

Deno.test("mixed top-up currencies share hypothetical proceeds in the original native funding proportions", () => {
  const mixed = { ...account, deposits: 50000,
    fundingHistory: [{ date: "2025-01-01", amount: 25000 }, { date: "2025-01-01", amount: 25000 }],
    cashHistory: [{ date: "2025-01-01", currency: "CZK", amount: 25000, type: "Deposit" },
      { date: "2025-01-01", currency: "EUR", amount: 1000, type: "Deposit" }] };
  const current = new Map([["USD", 1], ["CZK", .04], ["EUR", 1.2]]);
  const conversions = [conversion, { ...conversion, ticker: "EUR.USD", quantity: -1000, price: 1, currency: "USD" }];
  const currencyPnl = accountFxPnl(accountFxInputs([mixed], conversions), current)[0].pnl;
  near(currencyPnl, -200);
  const topups = accountTopups([mixed]);
  const result = proportionalCurrencyReturns(topups, currencyPnl, current);
  near(result.reduce((sum, item) => sum + item.saleProceeds * current.get(item.currency)!, 0), 2000);
  near(result.reduce((sum, item) => sum + item.pnl * current.get(item.currency)!, 0), -200);
  near(result[0].saleProceeds / 25000, result[1].saleProceeds / 1000);
  near(result[0].percentage!, -200 / 2200 * 100);
  near(result[1].percentage!, result[0].percentage!);
  // Changing the account's bookkeeping base cannot change the native basis.
  const usdBase = { ...mixed, currency: "USD", deposits: 2000,
    fundingHistory: mixed.fundingHistory.map(flow => ({ ...flow, amount: 1000 })) };
  deepStrictEqual(accountTopups([usdBase]), topups);
  deepStrictEqual(proportionalCurrencyReturns(accountTopups([usdBase]), currencyPnl, current), result);
});

Deno.test("withdrawals preserve earned returns and reinvestment never creates new top-ups", () => {
  const withdrawn = { ...account, withdrawals: 27000,
    fundingHistory: [...account.fundingHistory!, { date: "2025-01-03", amount: -27000 }],
    cashHistory: [...account.cashHistory!, { date: "2025-01-03", currency: "CZK", amount: -27000, type: "Withdrawal" }] };
  const current = new Map([["USD", 1], ["CZK", 1 / 27]]);
  const [result] = proportionalCurrencyReturns(accountTopups([withdrawn]), 2000 / 27, current);
  near(result.saleProceeds, 0);
  near(result.pnl, 2000);
  near(result.deposits, 25000);
});

Deno.test("alltime reports the CZK top-up return even with a USD broker base and USD display", async () => {
  const funded = { ...account, currency: "USD", deposits: 1000,
    fundingHistory: [{ date: "2025-01-01", amount: 1000 }] };
  const stock = { integrationId: 1, integrationKind: "ibkr", account: "A", ticker: "STOCK", assetCategory: "STK",
    currency: "USD", amount: 1, averageUnitPrice: 1000, currentPrice: 1000, totalInput: 1000, totalNow: 1000,
    unrealizedPnl: 0, realizedPnl: 0, dailyPnl: 0, dailyPnlPercentage: 0, dailyPnlBaseline: 1000,
    openedAt: new Date("2025-01-02") };
  const buy = { ...conversion, ticker: "STOCK", currency: "USD", assetCategory: "STK", quantity: 1, price: 1000,
    commission: { currency: "USD", amount: 0 } };
  const request: typeof fetch = () => Promise.resolve(Response.json({ base: "USD", quote: "CZK", rate: 27 }));
  const args = { positions: [stock], orders: [conversion, buy], accountPerformances: [funded], request,
    formatTicker: (ticker: string) => ticker };
  const report = (await buildIntegratedAllTimeReport(args))!;
  near(report.total.change!, 2000 / 27);
  near(report.totalReturnPercentage!, 8);
  near(report.currencyReturns[0].pnl, 2000);
  near(report.currencyReturns[0].saleProceeds, 27000);
  const text = await buildIntegratedAllTimePerformanceList(args);
  ok(text.includes("Total: +8.00% +$74.07"));
  ok(text.includes("Top-up return: +2,000.00 CZK"));
  near((await buildReportSnapshot(args, "alltime")).value, 2000 / 27);
});

Deno.test("FX P/L uses executed conversion rates and both directions, excluding commissions", () => {
  const first = fx(account, [conversion]);
  near(first.funding, 0);
  near(first.conversions, -250);
  // Converting $400 back at CZK 24 adds $80 relative to today's CZK 20 rate.
  near(fx(account, [conversion, { ...conversion, quantity: -400, price: 24 }]).pnl, -170);
  const thirdCurrency = { ...account, deposits: 2500,
    fundingHistory: [{ date: "2025-01-01", amount: 2500 }],
    cashHistory: [{ date: "2025-01-01", currency: "EUR", amount: 100, type: "Deposit" }] };
  const eurConversion = { ...conversion, ticker: "EUR.USD", quantity: -100, price: 1.2, currency: "USD" };
  // EUR funding basis: $125 now - CZK 2,500 * .05 = 0.
  // The actual conversion supplied $120, so its currency contribution is -$5.
  near(fx(thirdCurrency, [eurConversion]).pnl, -5);
  near(fx({ ...thirdCurrency, withdrawals: 500,
    fundingHistory: [...thirdCurrency.fundingHistory, { date: "2025-01-03", amount: -500 }],
    cashHistory: [...thirdCurrency.cashHistory, { date: "2025-01-03", currency: "EUR", amount: -20, type: "Withdrawal" }],
  }, [eurConversion]).pnl, -5);
});

Deno.test("cash-funded exclusions and pending deposits do not create or duplicate FX gains", () => {
  const allocated = { ...account, fundingSource: "account_allocated" as const, deposits: 23000,
    fundingHistory: [...account.fundingHistory!, { date: "2025-01-02", amount: -2000, allocation: true }] };
  near(fx(allocated, [conversion]).pnl, -250);
  const pending = { ...account, deposits: 26000,
    fundingHistory: [...account.fundingHistory!, { date: "2025-01-03", amount: 1000, provisional: true }],
    cashHistory: [...account.cashHistory!, { date: "2025-01-03", currency: "USD", amount: 50, type: "Unclassified cash (provisional)" }] };
  near(fx(pending, [conversion]).pnl, -250);
  deepStrictEqual(accountFxInputs([{ ...account, fundingSource: "bucket_cash" }], [conversion]), []);
  deepStrictEqual(accountFxInputs([{ ...account, cashHistory: undefined }], [conversion]), []);
});

Deno.test("CSV conversions keep fees and internal transfers out of currency principal", () => {
  const ledger = buildTrading212Ledger([
    { Action: "Deposit", ID: "d", "Time (UTC)": "2025-01-01 12:00:00", "Gross Total": "20", "Currency (Gross Total)": "EUR" },
    { Action: "Deposit", ID: "internal", "Time (UTC)": "2025-01-01 12:00:00", "Gross Total": "5", "Currency (Gross Total)": "EUR" },
    { Action: "Currency conversion", ID: "fx", "Time (UTC)": "2025-01-02 12:00:00",
      "Currency conversion from amount": "20", "Currency (Currency conversion from amount)": "EUR",
      "Currency conversion to amount": "25", "Currency (Currency conversion to amount)": "USD",
      "Currency conversion fee": "-0.10", "Currency (Currency conversion fee)": "USD" },
  ], new Set(["internal"]));
  const csvAccount = { ...account, currency: "EUR", deposits: 20, cashHistoryIncludesTrades: true,
    cashHistory: ledger.cashHistory, fundingHistory: ledger.fundingHistory };
  near(fx(csvAccount).funding, 0);
  near(fx(csvAccount).conversions, 0);
  near(ledger.cashHistory.filter(event => event.kind === "fee").reduce((sum, event) => sum + event.amount, 0), -.1);
  deepStrictEqual(ledger.cash, { EUR: 5, USD: 24.9 });
});

Deno.test("alltime sums stock performance and FX independently of account cash and valuation", async () => {
  const stock = { integrationId: 1, integrationKind: "ibkr", account: "A", ticker: "STOCK", assetCategory: "STK",
    currency: "USD", amount: 10, averageUnitPrice: 100, currentPrice: 110, totalInput: 1000, totalNow: 1100,
    unrealizedPnl: 100, realizedPnl: 0, dailyPnl: 0, dailyPnlPercentage: 0, dailyPnlBaseline: 1100,
    openedAt: new Date("2025-01-02") };
  const buy = { ...conversion, ticker: "STOCK", currency: "USD", assetCategory: "STK", quantity: 10, price: 100,
    commission: { currency: "USD", amount: 0 } };
  const request: typeof fetch = () => Promise.resolve(Response.json({ base: "USD", quote: "CZK", rate: 20 }));
  const funded = { ...account, totalValue: 23040, cash: 1000, ledgerCash: { CZK: 1000 }, deposits: 26000,
    positionValue: 22040, reportedComponents: [{ currency: "USD", cost: 1000, pnl: 100 }],
    fundingHistory: [{ date: "2025-01-01", amount: 26000 }],
    cashHistory: [{ date: "2025-01-01", currency: "CZK", amount: 26000, type: "Deposit" }] };
  const report = (await buildIntegratedAllTimeReport({ positions: [stock], orders: [conversion, buy],
    accountPerformances: [funded], request }))!;
  near(report.fx[0].pnl, -250);
  near(report.total.change!, -150);
  deepStrictEqual(report.accountAdjustments, [{ label: "Currency gain/loss", amount: -250 }]);
  // Changing live cash/valuation must not change either performance component.
  const changed = (await buildIntegratedAllTimeReport({ positions: [stock], orders: [conversion, buy],
    accountPerformances: [{ ...funded, cash: 3000, totalValue: 25040 }], request }))!;
  equal(changed.fx[0].pnl, report.fx[0].pnl);
  equal(changed.total.change, report.total.change);
  equal(changed.totalReturnPercentage, report.totalReturnPercentage);
  const history = new Map([[JSON.stringify(["STOCK", "USD"]), {
    symbol: "STOCK", currency: "USD", splits: [], bars: [
      { date: "2025-01-02", close: 100 }, { date: "2025-01-03", close: 110 },
    ],
  }]]);
  const historicalRates = new Map([["CZK", [{ date: "2024-12-31", factor: .05 }]]]);
  const args = { positions: [stock], orders: [conversion, buy], transactionBuckets: new Map<string, string>(),
    bucketName: null, now: new Date("2025-01-03"), accountPerformances: [funded] };
  const points = buildHistoricalReportSeries(args, history, rates, historicalRates, "alltime");
  near(points.at(-1)!.gain, report.total.change!);
  near(points.at(-2)!.gain, -250);
  // Prove that these paths do not even read account NAV or idle cash.
  const noBalances = { ...funded };
  Object.defineProperties(noBalances, {
    totalValue: { get() { throw new Error("alltime read account value"); } },
    cash: { get() { throw new Error("alltime read idle cash"); } },
    pnl: { get() { throw new Error("alltime read account P/L"); } },
  });
  const independent = { ...args, accountPerformances: [noBalances] };
  deepStrictEqual(buildHistoricalReportSeries(independent, history, rates, historicalRates, "alltime"), points);
  near((await buildReportSnapshot({ ...independent, request }, "alltime")).value, -150);
});
