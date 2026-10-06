import { fetchUsdConversionRates } from "../../utils/exchange_rates.ts";
import type { IntegrationPortfolioPosition } from "./types.ts";

export function usdFactor(
  currency: string,
  rates: ReadonlyMap<string, number>,
) {
  const factor = rates.get(currency.trim().toUpperCase());
  if (factor === undefined || !Number.isFinite(factor) || factor <= 0) {
    throw new Error(`USD conversion unavailable for ${currency}.`);
  }
  return factor;
}

export function portfolioPositionInUsd(
  position: IntegrationPortfolioPosition,
  rates: ReadonlyMap<string, number>,
): IntegrationPortfolioPosition {
  const factor = usdFactor(position.currency, rates);
  const convert = (value: number | null) =>
    value === null ? null : value * factor;
  return {
    ...position,
    currency: "USD",
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

export async function portfolioPositionsInUsd(
  positions: IntegrationPortfolioPosition[],
  request: typeof fetch = fetch,
) {
  const rates = await fetchUsdConversionRates(
    positions.map((p) => p.currency),
    request,
  );
  return positions.map((p) => portfolioPositionInUsd(p, rates));
}
