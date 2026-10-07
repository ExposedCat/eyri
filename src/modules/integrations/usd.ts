import { fetchConversionRates } from "../../utils/exchange_rates.ts";
import type { IntegrationPortfolioPosition } from "./types.ts";

export function conversionFactor(
  currency: string,
  rates: ReadonlyMap<string, number>,
) {
  const factor = rates.get(currency.trim().toUpperCase());
  if (factor === undefined || !Number.isFinite(factor) || factor <= 0) {
    throw new Error(`Currency conversion unavailable for ${currency}.`);
  }
  return factor;
}

export function portfolioPositionInCurrency(
  position: IntegrationPortfolioPosition,
  rates: ReadonlyMap<string, number>,
  currency = "USD",
): IntegrationPortfolioPosition {
  const factor = conversionFactor(position.currency, rates);
  const convert = (value: number | null) =>
    value === null ? null : value * factor;
  return {
    ...position,
    currency,
    currentPrice: convert(position.currentPrice),
    averageUnitPrice: convert(position.averageUnitPrice),
    totalInput: convert(position.totalInput),
    totalNow: convert(position.totalNow),
    unrealizedPnl: convert(position.unrealizedPnl),
    realizedPnl: convert(position.realizedPnl),
    dailyPnl: convert(position.dailyPnl),
    dailyPnlBaseline: convert(position.dailyPnlBaseline),
    dailyPnlTotalBaseline: position.dailyPnlTotalBaseline === undefined
      ? undefined
      : convert(position.dailyPnlTotalBaseline),
  };
}

export async function portfolioPositionsInCurrency(
  positions: IntegrationPortfolioPosition[],
  request: typeof fetch = fetch,
  currency = "USD",
) {
  const rates = await fetchConversionRates(
    positions.map((p) => p.currency),
    currency,
    request,
  );
  return positions.map((p) => portfolioPositionInCurrency(p, rates, currency));
}

// USD helpers remain the canonical conversion path for historical datasets.
export const usdFactor = conversionFactor;
export const portfolioPositionInUsd = portfolioPositionInCurrency;
export const portfolioPositionsInUsd = portfolioPositionsInCurrency;
