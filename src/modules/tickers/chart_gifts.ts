import type {
  IntegrationOrder,
  IntegrationPortfolioPosition,
} from "../integrations/types.ts";
import { portfolioValuations, usdFactor } from "../integrations/usd.ts";
import { historicalUsdFactor } from "../../utils/exchange_rates.ts";
import {
  historicalQuoteMultiplier,
  yahooOptionContract,
} from "../market_data/options.ts";
import { isCfdAllocation } from "./cfd_history.ts";
import { dayAfter, type PriceHistory } from "../market_data/history.ts";
import type { ChartBenchmark } from "./chart_benchmark.ts";

export type ChartGiftPoint = { date: string; valueUsd: number };
const key = (item: { ticker: string; currency: string }) =>
  JSON.stringify([
    item.ticker.trim().toUpperCase(),
    item.currency.trim().toUpperCase(),
  ]);
export const isGiftReceipt = (order: IntegrationOrder) =>
  order.receipt === "gift" ||
  order.quantity > 0 && order.price === 0 &&
    !yahooOptionContract(order.ticker) && !isCfdAllocation(order) &&
    ["STK", "STOCK"].includes(order.assetCategory?.toUpperCase() ?? "STK");

// Both portfolios receive and keep the same securities. No gift proceeds are
// invented, spent on the index, or added to the external funding denominator.
export function buildChartGifts(
  receipts: IntegrationOrder[],
  histories: Map<string, PriceHistory>,
  historicalRates: ReadonlyMap<string, { date: string; factor: number }[]>,
  positions: IntegrationPortfolioPosition[],
  currentRates: ReadonlyMap<string, number>,
  start: string,
  end: string,
): ChartGiftPoint[] {
  const gifts = receipts.filter(isGiftReceipt).filter((order) =>
    order.date.toISOString().slice(0, 10) <= end
  )
    .sort((a, b) => +a.date - +b.date);
  if (!gifts.length) return [];
  const lots = new Map<string, { instrument: string; quantity: number }>();
  const prices = new Map<string, number>(),
    barIndices = new Map<string, number>(),
    splitIndices = new Map<string, number>();
  const points: ChartGiftPoint[] = [];
  const instruments = new Map(gifts.map((gift) => [key(gift), gift]));
  let receipt = 0;
  const first = [start, gifts[0].date.toISOString().slice(0, 10)].sort()[0];
  for (let date = first; date <= end; date = dayAfter(date)) {
    for (const instrument of instruments.keys()) {
      const history = histories.get(instrument);
      if (!history) {
        throw new Error(
          `Gift price history is missing for ${JSON.parse(instrument)[0]}.`,
        );
      }
      let bar = barIndices.get(instrument) ?? 0;
      while (bar < history.bars.length && history.bars[bar].date <= date) {
        prices.set(instrument, history.bars[bar++].close);
      }
      barIndices.set(instrument, bar);
      let split = splitIndices.get(instrument) ?? 0;
      while (
        split < history.splits.length && history.splits[split].date <= date
      ) {
        const ratio = history.splits[split++].ratio;
        if (!Number.isFinite(ratio) || ratio <= 0) {
          throw new Error("Invalid gift stock split.");
        }
        for (const lot of lots.values()) {
          if (lot.instrument === instrument) lot.quantity *= ratio;
        }
      }
      splitIndices.set(instrument, split);
    }
    while (
      receipt < gifts.length &&
      gifts[receipt].date.toISOString().slice(0, 10) <= date
    ) {
      const gift = gifts[receipt++];
      const id = JSON.stringify([gift.integrationId, gift.account, key(gift)]);
      const lot = lots.get(id) ?? { instrument: key(gift), quantity: 0 };
      lot.quantity += gift.quantity;
      if (!Number.isFinite(lot.quantity) || lot.quantity < -1e-7) {
        throw new Error(
          `Gift return exceeds received shares for ${gift.ticker}.`,
        );
      }
      lots.set(id, lot);
    }
    let valueUsd = 0;
    for (const lot of lots.values()) {
      if (Math.abs(lot.quantity) < 1e-7) continue;
      const history = histories.get(lot.instrument)!,
        price = prices.get(lot.instrument);
      if (price === undefined || !Number.isFinite(price) || price <= 0) {
        throw new Error(
          `Gift closing price unavailable for ${
            JSON.parse(lot.instrument)[0]
          } on ${date}.`,
        );
      }
      const live = date === end
        ? positions.find((position) =>
          key(position) === lot.instrument && position.amount > 0
        )
        : undefined;
      const valuations = live && portfolioValuations(live);
      const mark = live && valuations?.every((valuation) =>
          valuation.totalNow !== null && Number.isFinite(valuation.totalNow)
        )
        ? valuations.reduce(
          (sum, valuation) =>
            sum +
            valuation.totalNow! * usdFactor(valuation.currency, currentRates),
          0,
        ) / live.amount
        : price * historicalQuoteMultiplier(instruments.get(lot.instrument)!) *
          historicalUsdFactor(historicalRates, history.currency, date);
      valueUsd += lot.quantity * mark;
    }
    if (date >= start) points.push({ date, valueUsd });
  }
  return points;
}

export function withChartGifts(
  benchmark: ChartBenchmark,
  gifts: ChartGiftPoint[],
): ChartBenchmark {
  if (!gifts.length) return benchmark;
  return {
    ...benchmark,
    points: benchmark.points.map((point) => {
      const gift = gifts.findLast((gift) =>
        gift.date <= point.date
      )?.valueUsd ?? 0;
      if (point.depositsUsd === undefined || point.value === undefined) {
        throw new Error(
          "Gift comparison needs a new chart snapshot. Create a new chart with /chart.",
        );
      }
      const gain = point.gain + gift;
      return {
        ...point,
        gain,
        value: point.value + gift,
        percentage: point.depositsUsd ? gain / point.depositsUsd * 100 : 0,
      };
    }),
  };
}
