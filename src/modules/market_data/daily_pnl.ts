import type { IntegrationPortfolioPosition } from "../integrations/types.ts";
import { isCfdAllocation } from "../tickers/cfd_history.ts";
import { dayAfter, type PriceHistory } from "./history.ts";
import { historicalQuoteMultiplier } from "./options.ts";
import type { YahooHistoryCache } from "./yahoo.ts";

type DailyHistory = Pick<YahooHistoryCache, "resolve" | "get" | "stored">;

function quoteFactor(history: PriceHistory, currency: string) {
  const from = history.currency.trim().toUpperCase();
  const to = currency.trim().toUpperCase();
  if (from === to) return 1;
  if (from === "GBX" && to === "GBP") return 0.01;
  if (from === "GBP" && to === "GBX") return 100;
  throw new Error(`Daily quote currency ${from} does not match ${to}.`);
}

// The bar before the latest is the previous session close: during a session
// the latest bar is today's, and outside one it is the last completed session.
function previousClose(history: PriceHistory) {
  const bars = history.bars.filter((bar) => Number.isFinite(bar.close) && bar.close > 0);
  return bars.length < 2 ? null : bars[bars.length - 2].close;
}

// Some brokers (Trading 212) never report daily P/L, and others can omit it
// for a holding. Derive it from market data; stored closes are marked cached.
export async function fillMissingDailyPnl(
  positions: IntegrationPortfolioPosition[],
  history: DailyHistory,
  now = new Date(),
) {
  const start = dayAfter(now.toISOString().slice(0, 10), -14);
  return await Promise.all(positions.map(async (position) => {
    if (
      position.dailyPnl !== null || position.amount === 0 ||
      position.currentPrice === null || isCfdAllocation(position)
    ) return position;
    let symbol: string;
    try {
      symbol = await history.resolve(position);
    } catch (error) {
      console.warn(`Daily P/L fallback: cannot resolve ${position.ticker}:`, error);
      return position;
    }
    let prices: PriceHistory | undefined;
    let cached = false;
    try {
      prices = await history.get(symbol, start);
    } catch (error) {
      console.warn(`Daily P/L fallback: live closes unavailable for ${position.ticker} (${symbol}):`, error);
      prices = history.stored(symbol, start);
      cached = true;
    }
    try {
      const close = prices ? previousClose(prices) : null;
      if (!prices || close === null) return position;
      const baseline = close * quoteFactor(prices, position.currency) *
        historicalQuoteMultiplier(position) * position.amount;
      const dailyPnl = position.currentPrice * position.amount - baseline;
      return {
        ...position,
        dailyPnl,
        dailyPnlBaseline: baseline,
        dailyPnlPercentage: baseline === 0 ? null : (dailyPnl / baseline) * 100,
        dailyPnlTotalBaseline: baseline,
        ...(cached ? { dailyPnlCached: true } : {}),
      };
    } catch (error) {
      console.warn(`Daily P/L fallback failed for ${position.ticker} (${symbol}):`, error);
      return position;
    }
  }));
}
