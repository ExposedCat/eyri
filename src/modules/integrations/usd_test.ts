import { deepStrictEqual, equal, match } from "node:assert/strict";
import { portfolioPositionsInUsd, portfolioPositionsInCurrency } from "./usd.ts";
import { mergePositions } from "./service.ts";
import { toTrading212Position } from "./trading212/adapter.ts";
import { buildIntegratedPerformanceList, buildIntegratedAllTimePerformanceList, buildIntegratedTickerList } from "../tickers/portfolio.ts";
import { buildPortfolioChart } from "../tickers/portfolio_chart.ts";
import type { IntegrationPortfolioPosition } from "./types.ts";

Deno.test("USD reporting converts all money fields, preserves unknowns, and does not mutate broker data", async () => {
  const source: IntegrationPortfolioPosition = {
    integrationId: 1,
    integrationKind: "t212",
    account: "test",
    ticker: "UK",
    currency: "GBX",
    amount: 2,
    currentPrice: 500,
    averageUnitPrice: 400,
    totalInput: 800,
    totalNow: 1000,
    unrealizedPnl: 200,
    realizedPnl: -100,
    dailyPnl: 50,
    dailyPnlBaseline: 950,
    dailyPnlTotalBaseline: 1000,
    dailyPnlPercentage: 50 / 950 * 100,
    openedAt: null,
  };
  const original = structuredClone(source);
  const [converted, unknown] = await portfolioPositionsInUsd([
    source,
    {
      ...source,
      currentPrice: null,
      averageUnitPrice: null,
      totalInput: null,
      totalNow: null,
      unrealizedPnl: null,
      realizedPnl: null,
      dailyPnl: null,
      dailyPnlBaseline: null,
      dailyPnlTotalBaseline: undefined,
    },
  ], async () => Response.json({ base: "USD", quote: "GBP", rate: .5 }));
  deepStrictEqual(converted, {
    ...source,
    currency: "USD",
    currentPrice: 10,
    averageUnitPrice: 8,
    totalInput: 16,
    totalNow: 20,
    unrealizedPnl: 4,
    realizedPnl: -2,
    dailyPnl: 1,
    dailyPnlBaseline: 19,
    dailyPnlTotalBaseline: 20,
  });
  equal(unknown.currentPrice, null);
  equal(unknown.totalInput, null);
  equal(unknown.dailyPnl, null);
  equal(unknown.dailyPnlBaseline, null);
  equal(unknown.dailyPnlTotalBaseline, undefined);
  deepStrictEqual(source, original);
});

Deno.test("T212 reporting preserves supplied wallet return, cost and value, including FX and broker rounding", async () => {
  const position = toTrading212Position({
    id: 1, userId: 1, kind: "t212", credentials: {}, createdAt: new Date(), updatedAt: new Date(),
  }, {
    instrument: { ticker: "AAPL_US_EQ", currency: "USD" },
    quantity: 2, averagePricePaid: 100, currentPrice: 110,
    walletImpact: { currency: "EUR", totalCost: 170, currentValue: 198, unrealizedProfitLoss: 27.99, fxImpact: 12 },
  })!;
  const request: typeof fetch = async (url) => Response.json({
    base: "USD", quote: String(url).endsWith("gbp") ? "GBP" : "EUR",
    rate: String(url).endsWith("gbp") ? .5 : .8,
  });
  const original = structuredClone(position);
  const [eur] = await portfolioPositionsInCurrency([position], request, "EUR");
  equal(eur.totalInput, 170);
  equal(eur.totalNow, 198);
  equal(eur.unrealizedPnl, 27.99);
  equal(eur.currentPrice, 99);
  equal(eur.averageUnitPrice, 85);
  const args = { positions: [position], request, currency: "EUR", formatTicker: (ticker: string) => ticker };
  match(await buildIntegratedPerformanceList(args), /AAPL \+16\.46% \+27\.99 EUR/);
  match(await buildIntegratedAllTimePerformanceList({ ...args, orders: [] }), /Total: \+16\.46% \+27\.99 EUR/);
  match(await buildIntegratedPerformanceList({ ...args, showCurrentValue: true }), /198\.00 EUR/);
  match(await buildIntegratedTickerList({ ...args, priceOverrides: { AAPL: 120 } }), /\+70\.00 EUR \+41\.18%/);
  const chart = await buildPortfolioChart([position], request, "EUR");
  equal(chart!.total, "198.00 EUR");
  equal(chart!.holdings[0].change, 27.99);
  const [usd] = await portfolioPositionsInUsd([position], request);
  equal(usd.totalInput, 212.5);
  equal(usd.totalNow, 247.5);
  equal(usd.unrealizedPnl, 27.99 * 1.25);
  const [gbp] = await portfolioPositionsInCurrency([position], request, "GBP");
  equal(gbp.totalInput, 106.25);
  equal(gbp.totalNow, 123.75);
  deepStrictEqual(position, original);

  const native = { ...position, brokerValuations: undefined, amount: 1, totalInput: 100, totalNow: 110 };
  const otherWallet = { ...native, brokerValuations: [{ currency: "GBP", totalInput: 50, totalNow: 55, unrealizedPnl: 5 }] };
  const merged = mergePositions([position, native, otherWallet]);
  const [combined] = await portfolioPositionsInCurrency(merged, request, "EUR");
  equal(combined.totalInput, 330);
  equal(combined.totalNow, 374);
  equal(Number(combined.unrealizedPnl!.toFixed(2)), 43.99);
  match(await buildIntegratedPerformanceList({ ...args, positions: merged }), /Total: \+13\.33% \+43\.99 EUR/);
});
