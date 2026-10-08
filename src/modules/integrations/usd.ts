import { fetchConversionRates } from "../../utils/exchange_rates.ts";
import type { IntegrationPortfolioPosition } from "./types.ts";

export function portfolioPositionCurrencies(position: Pick<IntegrationPortfolioPosition, "currency" | "brokerValuations">) {
  return [position.currency, ...(position.brokerValuations ?? []).map((v) => v.currency)];
}

export function portfolioValuations(position: IntegrationPortfolioPosition) {
  return position.brokerValuations ?? [{
    currency: position.currency,
    totalInput: position.totalInput,
    totalNow: position.currentPrice === null
      ? position.totalNow
      : position.currentPrice * position.amount,
    unrealizedPnl: position.currentPrice === null || position.totalInput === null
      ? position.unrealizedPnl
      : position.currentPrice * position.amount - position.totalInput,
  }];
}

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
  const broker = position.brokerValuations;
  const sum = (field: "totalInput" | "totalNow" | "unrealizedPnl") =>
    broker!.reduce<number | null>((total, valuation) =>
      total === null || valuation[field] === null ? null
        : total + valuation[field]! * conversionFactor(valuation.currency, rates), 0);
  const totalInput = broker ? sum("totalInput") : convert(position.totalInput);
  const totalNow = broker ? sum("totalNow") : convert(position.totalNow);
  return {
    ...position,
    currency,
    currentPrice: broker && position.amount !== 0
      ? totalNow === null ? null : totalNow / position.amount
      : convert(position.currentPrice),
    averageUnitPrice: broker && position.amount !== 0
      ? totalInput === null ? null : totalInput / position.amount
      : convert(position.averageUnitPrice),
    totalInput,
    totalNow,
    unrealizedPnl: broker ? sum("unrealizedPnl") : convert(position.unrealizedPnl),
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
    positions.flatMap(portfolioPositionCurrencies),
    currency,
    request,
  );
  return positions.map((p) => portfolioPositionInCurrency(p, rates, currency));
}

// USD helpers remain the canonical conversion path for historical datasets.
export const usdFactor = conversionFactor;
export const portfolioPositionInUsd = portfolioPositionInCurrency;
export const portfolioPositionsInUsd = portfolioPositionsInCurrency;
