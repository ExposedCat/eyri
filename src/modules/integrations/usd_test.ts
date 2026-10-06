import { deepStrictEqual, equal } from "node:assert/strict";
import { portfolioPositionsInUsd } from "./usd.ts";
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
