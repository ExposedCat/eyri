import { formatMoneyChange } from "../../utils/money.ts";
import { getPrices, refreshPersistentPrice } from "../database/price.ts";
import type { Database } from "../database/setup.ts";
import { getPositions, type User } from "../database/user.ts";
import {
  formatDecoratedTicker,
  type TickerDecorations,
  type TickerLabelLinks,
  type TickerLabelPreferences,
} from "./decorations.ts";

type BuildTickerListArgs = {
  database: Database;
  user: User;
  priceOverrides?: Record<string, number>;
  tickerDecorations?: TickerDecorations;
  tickerLabelPreferences?: TickerLabelPreferences;
  tickerLabelLinks?: TickerLabelLinks;
};

type BuildHistoryArgs = {
  user: User;
  tickerDecorations?: TickerDecorations;
  tickerLabelPreferences?: TickerLabelPreferences;
  tickerLabelLinks?: TickerLabelLinks;
};

type TickerPositionSummary = {
  amount: number;
  cost: number;
  oldestDate?: Date;
};

const formatMoney = (value: number) => `$${value.toFixed(2)}`;
const formatAmount = (value: number) => value.toFixed(2);
const PRICE_LIMIT_WARNING = "<i>price limit hit: showing cached data</i>";
const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;
const DAYS_PER_MONTH = 365.2425 / 12;

function getElapsedMonthCount(startDate: Date, endDate: Date) {
  const elapsedDays = Math.max(
    0,
    (endDate.getTime() - startDate.getTime()) / MILLISECONDS_PER_DAY,
  );
  return elapsedDays / DAYS_PER_MONTH;
}

function formatElapsedPeriodFromMonths(months: number) {
  if (months < 12) {
    return `${months.toFixed(1)} month`;
  }

  const years = Math.floor(months / 12);
  const remainingMonths = months - years * 12;
  return `${years} year ${remainingMonths.toFixed(1)} month`;
}

function getElapsedPeriod(startDate: Date | null | undefined, endDate: Date) {
  const months = startDate ? getElapsedMonthCount(startDate, endDate) : 0;
  return {
    months: Math.max(months, 0.1),
    label: formatElapsedPeriodFromMonths(months),
  };
}

function toDate(value: Date | string) {
  return value instanceof Date ? value : new Date(value);
}

async function refreshPrices(database: Database, tickers: string[]) {
  const refreshResults = await Promise.all(
    [...new Set(tickers)].map((ticker) =>
      refreshPersistentPrice(database, ticker),
    ),
  );

  return refreshResults.some((success) => !success);
}

function appendPriceLimitWarning(
  output: string,
  hasFailedPriceRequest: boolean,
) {
  return hasFailedPriceRequest ? `${PRICE_LIMIT_WARNING}\n\n${output}` : output;
}

function getTickerPositionSummaries(user: User) {
  return user.positions.reduce(
    (list, position) => {
      const ticker = position.ticker;
      const positionDate = toDate(position.date);
      list[ticker] ??= { amount: 0, cost: 0 };
      list[ticker].amount += position.amount;
      list[ticker].cost += position.price;
      if (!list[ticker].oldestDate || positionDate < list[ticker].oldestDate) {
        list[ticker].oldestDate = positionDate;
      }
      return list;
    },
    {} as Record<string, TickerPositionSummary>,
  );
}

export async function buildTickerList({
  database,
  user,
  priceOverrides,
  tickerDecorations,
  tickerLabelPreferences,
  tickerLabelLinks,
}: BuildTickerListArgs) {
  if (user.positions.length === 0) {
    return "";
  }

  const tickers = user.positions.map((position) => position.ticker);
  const hasFailedPriceRequest = await refreshPrices(database, tickers);

  const prices = await getPrices(database, tickers);
  const positions = getPositions(user);
  const now = new Date();
  const earliestDatesByTicker = user.positions.reduce(
    (list, position) => {
      const ticker = position.ticker;
      const positionDate = toDate(position.date);
      const previousDate = list[ticker];
      if (!previousDate || positionDate < previousDate) {
        list[ticker] = positionDate;
      }
      return list;
    },
    {} as Record<string, Date>,
  );
  const earliestPortfolioDate = Object.values(earliestDatesByTicker).reduce(
    (earliest, date) => (!earliest || date < earliest ? date : earliest),
    null as Date | null,
  );

  const tickerLines = Object.entries(positions).map(
    ([ticker, { amount, cost }]) => {
      const tickerName = formatDecoratedTicker(
        ticker,
        tickerDecorations,
        tickerLabelPreferences,
        tickerLabelLinks,
      );
      const currentPrice = priceOverrides?.[ticker] ?? prices[ticker]?.price;
      const oldestDate = earliestDatesByTicker[ticker];
      const elapsedPeriod = getElapsedPeriod(oldestDate, now);
      const totalInput = cost;
      const averageUnitPrice = amount === 0 ? 0 : totalInput / amount;
      if (currentPrice === undefined || currentPrice === null) {
        return [
          `${tickerName} ? ?`,
          `${formatMoney(averageUnitPrice)} x ${formatAmount(amount)} (? ?)`,
          `${formatMoney(totalInput)} -> ? x ${elapsedPeriod.label}`,
        ].join("\n");
      }

      const totalNow = amount * currentPrice;
      const totalChange = totalNow - totalInput;
      const totalPercentageChange = totalInput === 0
        ? 0
        : (totalChange / totalInput) * 100;
      const currentVsAverageChange = currentPrice - averageUnitPrice;

      return [
        `${tickerName} ${formatMoneyChange(totalChange)} ${
          formatMoneyChange(
            totalPercentageChange,
            "%",
          )
        }`,
        `${formatMoney(averageUnitPrice)} x ${formatAmount(amount)} (${
          formatMoney(
            currentPrice,
          )
        } ${formatMoneyChange(currentVsAverageChange)})`,
        `${formatMoney(totalInput)} -> ${
          formatMoney(
            totalNow,
          )
        } x ${elapsedPeriod.label}`,
      ].join("\n");
    },
  );

  const portfolioElapsedPeriod = getElapsedPeriod(earliestPortfolioDate, now);
  const portfolioTotals = Object.entries(positions).reduce(
    (totals, [ticker, { amount, cost }]) => {
      const currentPrice = priceOverrides?.[ticker] ?? prices[ticker]?.price;
      totals.totalInput += cost;
      if (currentPrice === undefined || currentPrice === null) {
        totals.hasMissingPrice = true;
        return totals;
      }

      totals.totalNow += amount * currentPrice;
      return totals;
    },
    { totalInput: 0, totalNow: 0, hasMissingPrice: false },
  );

  const totalSummary = portfolioTotals.hasMissingPrice ? "? ? / ? ?" : (() => {
    const totalChange = portfolioTotals.totalNow - portfolioTotals.totalInput;
    const totalPercentageChange = portfolioTotals.totalInput === 0
      ? 0
      : (totalChange / portfolioTotals.totalInput) * 100;
    const monthlyChange = totalChange / portfolioElapsedPeriod.months;
    const monthlyPercentageChange = totalPercentageChange /
      portfolioElapsedPeriod.months;
    return `${formatMoneyChange(totalChange)} ${
      formatMoneyChange(
        totalPercentageChange,
        "%",
      )
    } / ${formatMoneyChange(monthlyChange)} ${
      formatMoneyChange(
        monthlyPercentageChange,
        "%",
      )
    } (${portfolioElapsedPeriod.label})`;
  })();

  return appendPriceLimitWarning(
    [...tickerLines, totalSummary].join("\n\n"),
    hasFailedPriceRequest,
  );
}

export async function buildPerformanceList({
  database,
  user,
  priceOverrides,
  tickerDecorations,
  tickerLabelPreferences,
  tickerLabelLinks,
}: BuildTickerListArgs) {
  if (user.positions.length === 0) {
    return "";
  }

  const tickers = user.positions.map((position) => position.ticker);
  const hasFailedPriceRequest = await refreshPrices(database, tickers);

  const prices = await getPrices(database, tickers);
  const positions = getTickerPositionSummaries(user);
  const now = new Date();
  const earliestPortfolioDate = Object.values(positions).reduce(
    (earliest, position) =>
      !position.oldestDate
        ? earliest
        : !earliest || position.oldestDate < earliest
        ? position.oldestDate
        : earliest,
    null as Date | null,
  );

  let totalInput = 0;
  let totalNow = 0;
  let hasMissingPrice = false;

  const lines = Object.entries(positions).map(([ticker, position]) => {
    const tickerName = formatDecoratedTicker(
      ticker,
      tickerDecorations,
      tickerLabelPreferences,
      tickerLabelLinks,
    );
    const currentPrice = priceOverrides?.[ticker] ?? prices[ticker]?.price;
    const elapsedPeriod = getElapsedPeriod(position.oldestDate, now);
    totalInput += position.cost;

    if (currentPrice === undefined || currentPrice === null) {
      hasMissingPrice = true;
      return `${tickerName} ? ? (${elapsedPeriod.label})`;
    }

    const tickerTotalNow = position.amount * currentPrice;
    const change = tickerTotalNow - position.cost;
    const percentageChange = position.cost === 0
      ? 0
      : (change / position.cost) * 100;
    totalNow += tickerTotalNow;

    return `${tickerName} ${
      formatMoneyChange(
        percentageChange,
        "%",
      )
    } ${formatMoneyChange(change)} (${elapsedPeriod.label})`;
  });

  const portfolioElapsedPeriod = getElapsedPeriod(earliestPortfolioDate, now);
  const totalLine = hasMissingPrice
    ? `Total: ? ? (${portfolioElapsedPeriod.label})`
    : (() => {
      const change = totalNow - totalInput;
      const percentageChange = totalInput === 0
        ? 0
        : (change / totalInput) * 100;
      return `Total: ${
        formatMoneyChange(
          percentageChange,
          "%",
        )
      } ${formatMoneyChange(change)} (${portfolioElapsedPeriod.label})`;
    })();

  return appendPriceLimitWarning(
    [...lines, totalLine].join("\n\n"),
    hasFailedPriceRequest,
  );
}

export function buildHistory({
  user,
  tickerDecorations,
  tickerLabelPreferences,
  tickerLabelLinks,
}: BuildHistoryArgs) {
  if (user.positions.length === 0) {
    return "";
  }

  const sorted = [...user.positions].sort((posA, posB) => {
    const dateA = toDate(posA.date);
    const dateB = toDate(posB.date);
    return dateA.getTime() - dateB.getTime();
  });

  const pad = (value: number) => String(value).padStart(2, "0");

  const grouped = new Map<number, { lines: string[]; total: number }>();
  for (const position of sorted) {
    const date = toDate(position.date);
    const year = date.getFullYear();
    const unitPrice = position.amount === 0
      ? 0
      : position.price / position.amount;
    const tickerName = formatDecoratedTicker(
      position.ticker,
      tickerDecorations,
      tickerLabelPreferences,
      tickerLabelLinks,
    );
    const line = `${pad(date.getDate())}.${
      pad(
        date.getMonth() + 1,
      )
    } ${tickerName} ${position.amount.toFixed(4)} x $${
      unitPrice.toFixed(
        2,
      )
    } ($${position.price.toFixed(0)})`;
    const group = grouped.get(year) ?? { lines: [], total: 0 };
    group.lines.push(line);
    group.total += position.price;
    grouped.set(year, group);
  }

  let grandTotal = 0;
  const sections = [...grouped.entries()].map(([year, { lines, total }]) => {
    grandTotal += total;
    return `${year} - $${total.toFixed(0)}\n${lines.join("\n")}`;
  });

  sections.push(`Total $${grandTotal.toFixed(0)}`);
  return sections.join("\n\n");
}

export function parsePriceOverrides(
  input: string,
): Record<string, number> | null {
  const pairs = input.split(" ");
  const overrides: Record<string, number> = {};
  for (const pair of pairs) {
    const [ticker, priceStr] = pair.split("=");
    const price = Number(priceStr);
    if (!ticker || !priceStr || Number.isNaN(price)) {
      return null;
    }
    overrides[ticker.trim().toUpperCase()] = price;
  }
  return overrides;
}
