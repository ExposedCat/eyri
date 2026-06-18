import { formatMoneyChange } from "../../utils/money.ts";
import type {
  IntegrationOrder,
  IntegrationPortfolioPosition,
} from "../integrations/types.ts";
import {
  formatDecoratedTicker,
  type TickerDecorations,
  type TickerEmojiMappings,
  type TickerLabelLinks,
  type TickerLabelPreferences,
} from "./decorations.ts";

type BuildIntegratedTickerListArgs = {
  positions: IntegrationPortfolioPosition[];
  priceOverrides?: Record<string, number>;
  tickerDecorations?: TickerDecorations;
  tickerLabelPreferences?: TickerLabelPreferences;
  tickerLabelLinks?: TickerLabelLinks;
  tickerEmojiMappings?: TickerEmojiMappings;
  formatTicker?: (ticker: string) => string;
};

type BuildIntegratedHistoryArgs = {
  orders: IntegrationOrder[];
  tickerDecorations?: TickerDecorations;
  tickerLabelPreferences?: TickerLabelPreferences;
  tickerLabelLinks?: TickerLabelLinks;
  tickerEmojiMappings?: TickerEmojiMappings;
};

type BuildIntegratedSoldPerformanceArgs = BuildIntegratedHistoryArgs & {
  formatTicker?: (ticker: string) => string;
};

type IntegratedPositionPerformance = {
  position: IntegrationPortfolioPosition;
  currentPrice: number | null;
  averageUnitPrice: number | null;
  totalInput: number | null;
  totalNow: number | null;
  totalChange: number | null;
  totalPercentageChange: number | null;
  currentVsAverageChange: number | null;
  elapsedPeriod: ReturnType<typeof getElapsedPeriod>;
};

const formatMoney = (value: number, currency = "USD") =>
  currency === "USD"
    ? `$${value.toFixed(2)}`
    : `${value.toFixed(2)} ${currency}`;
const formatWholeMoney = (value: number, currency = "USD") =>
  currency === "USD"
    ? `$${value.toFixed(0)}`
    : `${value.toFixed(0)} ${currency}`;
const formatAmount = (value: number) => value.toFixed(2);
const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;
const DAYS_PER_MONTH = 365.2425 / 12;
const GAINER_LOSER_SEPARATOR = Array.from(
  { length: 7 },
  () => '<tg-emoji emoji-id="5463362738845671608">.</tg-emoji>',
).join("");
const optionMonthQuarters: Record<string, string> = {
  JAN: "Q1",
  FEB: "Q1",
  MAR: "Q1",
  APR: "Q2",
  MAY: "Q2",
  JUN: "Q2",
  JUL: "Q3",
  AUG: "Q3",
  SEP: "Q3",
  OCT: "Q4",
  NOV: "Q4",
  DEC: "Q4",
};

type ParsedOptionTicker = {
  underlying: string;
  month: string;
  year: string;
  strike: string;
};

export function isOptionTicker(ticker: string) {
  return ticker.trim().startsWith("+");
}

export function isOptionPosition(position: IntegrationPortfolioPosition) {
  return isOptionTicker(position.ticker);
}

export function isStockPosition(position: IntegrationPortfolioPosition) {
  return !isOptionPosition(position);
}

function parseOptionTicker(ticker: string): ParsedOptionTicker | null {
  const match = ticker
    .trim()
    .toUpperCase()
    .match(/^\+(.+)\.(\d{1,2})([A-Z]{3})(\d{4})\.([CP])(.+)$/);
  if (!match) {
    return null;
  }

  const [, underlying, , month, year, , strike] = match;
  return { underlying, month, year, strike };
}

function formatOptionStrike(strike: string) {
  const number = Number(strike);
  if (!Number.isFinite(number)) {
    return strike;
  }

  return Number.isInteger(number)
    ? number.toFixed(0)
    : number.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
}

function formatTickerName(
  ticker: string,
  tickerDecorations?: TickerDecorations,
  tickerLabelPreferences?: TickerLabelPreferences,
  tickerLabelLinks?: TickerLabelLinks,
  tickerEmojiMappings?: TickerEmojiMappings,
  formatter?: (ticker: string) => string,
) {
  if (formatter) {
    return formatter(ticker);
  }

  return formatDecoratedTicker(
    ticker,
    tickerDecorations,
    tickerLabelPreferences,
    tickerLabelLinks,
    tickerEmojiMappings,
  );
}

export function formatOptionTicker(
  ticker: string,
  tickerDecorations?: TickerDecorations,
  tickerLabelPreferences?: TickerLabelPreferences,
  tickerLabelLinks?: TickerLabelLinks,
  tickerEmojiMappings?: TickerEmojiMappings,
) {
  const parsed = parseOptionTicker(ticker);
  if (!parsed) {
    return formatDecoratedTicker(
      ticker,
      tickerDecorations,
      tickerLabelPreferences,
      tickerLabelLinks,
      tickerEmojiMappings,
    );
  }

  const underlying = formatDecoratedTicker(
    parsed.underlying,
    tickerDecorations,
    tickerLabelPreferences,
    tickerLabelLinks,
    tickerEmojiMappings,
  );
  const quarter = optionMonthQuarters[parsed.month] ?? parsed.month;
  return `${underlying} → $${formatOptionStrike(parsed.strike)} ${quarter}'${parsed.year.slice(-2)}`;
}

function getElapsedMonthCount(startDate: Date, endDate: Date) {
  const elapsedDays = Math.max(
    0,
    (endDate.getTime() - startDate.getTime()) / MILLISECONDS_PER_DAY,
  );
  return elapsedDays / DAYS_PER_MONTH;
}

function getElapsedDayCount(startDate: Date, endDate: Date) {
  return Math.max(
    0,
    (endDate.getTime() - startDate.getTime()) / MILLISECONDS_PER_DAY,
  );
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
  if (!startDate) {
    return {
      days: null,
      months: null,
      label: "?",
    };
  }

  const days = getElapsedDayCount(startDate, endDate);
  const months = getElapsedMonthCount(startDate, endDate);
  return {
    days: Math.max(days, 1),
    months: Math.max(months, 0.1),
    label: formatElapsedPeriodFromMonths(months),
  };
}

function getPriceOverride(
  priceOverrides: Record<string, number> | undefined,
  ticker: string,
) {
  return priceOverrides?.[ticker] ?? priceOverrides?.[ticker.toUpperCase()];
}

function getSortedIntegratedPositions(
  positions: IntegrationPortfolioPosition[],
) {
  return [...positions].sort((positionA, positionB) => {
    const totalInputA = positionA.totalInput ?? 0;
    const totalInputB = positionB.totalInput ?? 0;
    return (
      totalInputB - totalInputA ||
      positionA.ticker.localeCompare(positionB.ticker)
    );
  });
}

function getSortedIntegratedPerformances(
  performances: IntegratedPositionPerformance[],
  getChange: (performance: IntegratedPositionPerformance) => number | null = (
    performance,
  ) => performance.totalChange,
) {
  return [...performances].sort((performanceA, performanceB) => {
    const totalChangeA = getChange(performanceA) ?? Number.NEGATIVE_INFINITY;
    const totalChangeB = getChange(performanceB) ?? Number.NEGATIVE_INFINITY;
    return (
      totalChangeB - totalChangeA ||
      performanceA.position.ticker.localeCompare(performanceB.position.ticker)
    );
  });
}

function buildSeparatedChangeLines<T>(
  items: T[],
  getChange: (item: T) => number | null,
  renderLine: (item: T) => string,
) {
  const gainers: string[] = [];
  const losers: string[] = [];
  const unknown: string[] = [];

  for (const item of items) {
    const change = getChange(item);
    const line = renderLine(item);
    if (change === null) {
      unknown.push(line);
    } else if (change < 0) {
      losers.push(line);
    } else {
      gainers.push(line);
    }
  }

  return [
    ...gainers,
    ...(gainers.length > 0 && losers.length > 0
      ? [GAINER_LOSER_SEPARATOR]
      : []),
    ...losers,
    ...unknown,
  ];
}

function buildIntegratedPositionPerformance(
  position: IntegrationPortfolioPosition,
  now: Date,
  priceOverrides?: Record<string, number>,
): IntegratedPositionPerformance {
  const currentPrice =
    getPriceOverride(priceOverrides, position.ticker) ?? position.currentPrice;
  const totalInput = position.totalInput;
  const averageUnitPrice = position.averageUnitPrice;
  const elapsedPeriod = getElapsedPeriod(position.openedAt, now);

  if (
    currentPrice === undefined ||
    currentPrice === null ||
    totalInput === null ||
    averageUnitPrice === null
  ) {
    return {
      position,
      currentPrice: null,
      averageUnitPrice,
      totalInput,
      totalNow: null,
      totalChange: null,
      totalPercentageChange: null,
      currentVsAverageChange: null,
      elapsedPeriod,
    };
  }

  const totalNow = position.amount * currentPrice;
  const totalChange = totalNow - totalInput;
  const totalPercentageChange =
    totalInput === 0 ? 0 : (totalChange / totalInput) * 100;

  return {
    position,
    currentPrice,
    averageUnitPrice,
    totalInput,
    totalNow,
    totalChange,
    totalPercentageChange,
    currentVsAverageChange: currentPrice - averageUnitPrice,
    elapsedPeriod,
  };
}

function buildIntegratedPortfolioTotals(
  performances: IntegratedPositionPerformance[],
  now: Date,
) {
  const earliestPortfolioDate = performances.reduce(
    (earliest, { position }) =>
      !position.openedAt
        ? earliest
        : !earliest || position.openedAt < earliest
          ? position.openedAt
          : earliest,
    null as Date | null,
  );
  const elapsedPeriod = getElapsedPeriod(earliestPortfolioDate, now);

  const totals = performances.reduce(
    (totals, performance) => {
      if (performance.totalInput !== null) {
        totals.totalInput += performance.totalInput;
      }
      if (performance.totalNow === null || performance.totalChange === null) {
        totals.hasMissingPrice = true;
        return totals;
      }

      totals.totalNow += performance.totalNow;
      return totals;
    },
    { totalInput: 0, totalNow: 0, hasMissingPrice: false },
  );

  if (totals.hasMissingPrice) {
    return {
      ...totals,
      totalChange: null,
      totalPercentageChange: null,
      dailyChange: null,
      dailyPercentageChange: null,
      monthlyChange: null,
      monthlyPercentageChange: null,
      elapsedPeriod,
    };
  }

  const totalChange = totals.totalNow - totals.totalInput;
  const totalPercentageChange =
    totals.totalInput === 0 ? 0 : (totalChange / totals.totalInput) * 100;
  const dailyPnlTotals = performances.reduce(
    (totals, { position }) => {
      if (position.dailyPnl === null) {
        totals.hasMissingDailyPnl = true;
        return totals;
      }

      totals.dailyPnl += position.dailyPnl;
      if (
        position.dailyPnlBaseline === null ||
        position.dailyPnlBaseline === 0
      ) {
        totals.hasMissingDailyPnlPercentage = true;
        return totals;
      }

      totals.dailyPnlBaseline += position.dailyPnlBaseline;
      return totals;
    },
    {
      dailyPnl: 0,
      dailyPnlBaseline: 0,
      hasMissingDailyPnl: false,
      hasMissingDailyPnlPercentage: false,
    },
  );
  const dailyPnlPercentage =
    dailyPnlTotals.hasMissingDailyPnlPercentage ||
    dailyPnlTotals.dailyPnlBaseline === 0
      ? null
      : (dailyPnlTotals.dailyPnl / dailyPnlTotals.dailyPnlBaseline) * 100;

  return {
    ...totals,
    totalChange,
    totalPercentageChange,
    dailyChange: dailyPnlTotals.hasMissingDailyPnl
      ? null
      : dailyPnlTotals.dailyPnl,
    dailyPercentageChange: dailyPnlTotals.hasMissingDailyPnl
      ? null
      : dailyPnlPercentage,
    monthlyChange:
      elapsedPeriod.months === null ? null : totalChange / elapsedPeriod.months,
    monthlyPercentageChange:
      elapsedPeriod.months === null
        ? null
        : totalPercentageChange / elapsedPeriod.months,
    elapsedPeriod,
  };
}

type IntegratedSoldPerformance = {
  ticker: string;
  currency: string;
  cost: number;
  proceeds: number;
  realizedPnl: number;
  realizedPercentageChange: number;
  openedAt: Date | null;
  closedAt: Date | null;
};

function getOrderPositionKey(order: IntegrationOrder) {
  return [
    order.integrationId,
    order.account.trim().toUpperCase(),
    order.ticker.trim().toUpperCase(),
    order.currency.trim().toUpperCase(),
  ].join(":");
}

function buildIntegratedSoldPerformances(orders: IntegrationOrder[]) {
  const lotsByKey = new Map<
    string,
    {
      ticker: string;
      currency: string;
      quantity: number;
      price: number;
      date: Date;
    }[]
  >();
  const soldByDisplayKey = new Map<string, IntegratedSoldPerformance>();

  const sortedOrders = [...orders]
    .filter(isDisplayableOrder)
    .sort((orderA, orderB) => orderA.date.getTime() - orderB.date.getTime());

  for (const order of sortedOrders) {
    const orderKey = getOrderPositionKey(order);
    const lots = lotsByKey.get(orderKey) ?? [];

    if (order.quantity > 0) {
      lots.push({
        ticker: order.ticker,
        currency: order.currency,
        quantity: order.quantity,
        price: order.price ?? 0,
        date: order.date,
      });
      lotsByKey.set(orderKey, lots);
      continue;
    }

    let remainingSellQuantity = Math.abs(order.quantity);
    while (remainingSellQuantity > 0 && lots.length > 0) {
      const lot = lots[0];
      const quantity = Math.min(lot.quantity, remainingSellQuantity);
      const cost = quantity * lot.price;
      const proceeds = quantity * (order.price ?? 0);
      const realizedPnl = proceeds - cost;
      const displayKey = [
        order.ticker.trim().toUpperCase(),
        order.currency.trim().toUpperCase(),
      ].join(":");
      const sold = soldByDisplayKey.get(displayKey) ?? {
        ticker: order.ticker,
        currency: order.currency,
        cost: 0,
        proceeds: 0,
        realizedPnl: 0,
        realizedPercentageChange: 0,
        openedAt: null,
        closedAt: null,
      };

      sold.cost += cost;
      sold.proceeds += proceeds;
      sold.realizedPnl += realizedPnl;
      sold.openedAt =
        sold.openedAt === null || lot.date < sold.openedAt
          ? lot.date
          : sold.openedAt;
      sold.closedAt =
        sold.closedAt === null || order.date > sold.closedAt
          ? order.date
          : sold.closedAt;
      sold.realizedPercentageChange =
        sold.cost === 0 ? 0 : (sold.realizedPnl / sold.cost) * 100;
      soldByDisplayKey.set(displayKey, sold);

      lot.quantity -= quantity;
      remainingSellQuantity -= quantity;
      if (lot.quantity <= 0) {
        lots.shift();
      }
    }

    lotsByKey.set(orderKey, lots);
  }

  return [...soldByDisplayKey.values()].sort(
    (soldA, soldB) =>
      soldB.realizedPnl - soldA.realizedPnl ||
      soldA.ticker.localeCompare(soldB.ticker),
  );
}

function buildIntegratedSoldTotals(performances: IntegratedSoldPerformance[]) {
  const totals = performances.reduce(
    (totals, performance) => {
      totals.cost += performance.cost;
      totals.proceeds += performance.proceeds;
      totals.realizedPnl += performance.realizedPnl;
      totals.openedAt =
        performance.openedAt &&
        (totals.openedAt === null || performance.openedAt < totals.openedAt)
          ? performance.openedAt
          : totals.openedAt;
      totals.closedAt =
        performance.closedAt &&
        (totals.closedAt === null || performance.closedAt > totals.closedAt)
          ? performance.closedAt
          : totals.closedAt;
      return totals;
    },
    {
      cost: 0,
      proceeds: 0,
      realizedPnl: 0,
      openedAt: null as Date | null,
      closedAt: null as Date | null,
    },
  );

  return {
    ...totals,
    realizedPercentageChange:
      totals.cost === 0 ? 0 : (totals.realizedPnl / totals.cost) * 100,
  };
}

export async function buildIntegratedTickerList({
  positions,
  priceOverrides,
  tickerDecorations,
  tickerLabelPreferences,
  tickerLabelLinks,
  tickerEmojiMappings,
  formatTicker,
}: BuildIntegratedTickerListArgs) {
  if (positions.length === 0) {
    return "";
  }

  const now = new Date();
  const performances = getSortedIntegratedPerformances(
    getSortedIntegratedPositions(positions).map((position) =>
      buildIntegratedPositionPerformance(position, now, priceOverrides),
    ),
  );

  const tickerLines = performances.map((performance) => {
    const { position } = performance;
    const tickerName = formatTickerName(
      position.ticker,
      tickerDecorations,
      tickerLabelPreferences,
      tickerLabelLinks,
      tickerEmojiMappings,
      formatTicker,
    );

    if (
      performance.currentPrice === null ||
      performance.totalInput === null ||
      performance.totalChange === null ||
      performance.totalPercentageChange === null ||
      performance.averageUnitPrice === null ||
      performance.totalNow === null ||
      performance.currentVsAverageChange === null
    ) {
      return [
        `${tickerName} ? ?`,
        `? x ${formatAmount(position.amount)} (? ?)`,
        `? -> ? x ${performance.elapsedPeriod.label}`,
      ].join("\n");
    }

    const monthlySummary =
      performance.elapsedPeriod.months === null
        ? "? ?/m"
        : `${formatMoneyChange(
            performance.totalChange / performance.elapsedPeriod.months,
          )} ${formatMoneyChange(
            performance.totalPercentageChange /
              performance.elapsedPeriod.months,
            "%",
          )}/m`;

    return [
      `${tickerName} ${formatMoneyChange(performance.totalChange)} ${formatMoneyChange(
        performance.totalPercentageChange,
        "%",
      )}`,
      `${formatMoney(performance.averageUnitPrice, position.currency)} x ${formatAmount(
        position.amount,
      )} (${formatMoney(performance.currentPrice, position.currency)} ${formatMoneyChange(
        performance.currentVsAverageChange,
      )})`,
      `${formatMoney(performance.totalInput, position.currency)} -> ${formatMoney(
        performance.totalNow,
        position.currency,
      )} x ${performance.elapsedPeriod.label} (${monthlySummary})`,
    ].join("\n");
  });

  const totals = buildIntegratedPortfolioTotals(performances, now);
  const totalSummary =
    totals.totalChange === null ||
    totals.totalPercentageChange === null ||
    totals.monthlyChange === null ||
    totals.monthlyPercentageChange === null
      ? `? ? / ? ? (${totals.elapsedPeriod.label})`
      : `${formatMoneyChange(totals.totalChange)} ${formatMoneyChange(
          totals.totalPercentageChange,
          "%",
        )} / ${formatMoneyChange(totals.monthlyChange)} ${formatMoneyChange(
          totals.monthlyPercentageChange,
          "%",
        )} (${totals.elapsedPeriod.label})`;

  return [...tickerLines, totalSummary].join("\n\n");
}

export async function buildIntegratedPerformanceList({
  positions,
  priceOverrides,
  tickerDecorations,
  tickerLabelPreferences,
  tickerLabelLinks,
  tickerEmojiMappings,
  formatTicker,
}: BuildIntegratedTickerListArgs) {
  if (positions.length === 0) {
    return "";
  }

  const now = new Date();
  const performances = getSortedIntegratedPerformances(
    getSortedIntegratedPositions(positions).map((position) =>
      buildIntegratedPositionPerformance(position, now, priceOverrides),
    ),
  );

  const lines = buildSeparatedChangeLines(
    performances,
    (performance) => performance.totalChange,
    (performance) => {
      const { position } = performance;
      const tickerName = formatTickerName(
        position.ticker,
        tickerDecorations,
        tickerLabelPreferences,
        tickerLabelLinks,
        tickerEmojiMappings,
        formatTicker,
      );
      if (
        performance.totalChange === null ||
        performance.totalPercentageChange === null
      ) {
        return `${tickerName} ? ? (${performance.elapsedPeriod.label})`;
      }

      return `${tickerName} ${formatMoneyChange(
        performance.totalPercentageChange,
        "%",
      )} ${formatMoneyChange(
        performance.totalChange,
      )} (${performance.elapsedPeriod.label})`;
    },
  );

  const totals = buildIntegratedPortfolioTotals(performances, now);
  const totalLine =
    totals.totalChange === null || totals.totalPercentageChange === null
      ? `Total: ? ? (${totals.elapsedPeriod.label})`
      : `Total: ${formatMoneyChange(totals.totalPercentageChange, "%")} ${formatMoneyChange(
          totals.totalChange,
        )} (${totals.elapsedPeriod.label})`;

  return [...lines, totalLine].join("\n\n");
}

export async function buildIntegratedSoldPerformanceList({
  orders,
  tickerDecorations,
  tickerLabelPreferences,
  tickerLabelLinks,
  tickerEmojiMappings,
  formatTicker,
}: BuildIntegratedSoldPerformanceArgs) {
  const performances = buildIntegratedSoldPerformances(orders);
  if (performances.length === 0) {
    return "";
  }

  const lines = buildSeparatedChangeLines(
    performances,
    (performance) => performance.realizedPnl,
    (performance) => {
      const tickerName = formatTickerName(
        performance.ticker,
        tickerDecorations,
        tickerLabelPreferences,
        tickerLabelLinks,
        tickerEmojiMappings,
        formatTicker,
      );
      const elapsedPeriod = getElapsedPeriod(
        performance.openedAt,
        performance.closedAt ?? new Date(),
      );

      return `${tickerName} ${formatMoneyChange(
        performance.realizedPercentageChange,
        "%",
      )} ${formatMoneyChange(performance.realizedPnl)} (${elapsedPeriod.label})`;
    },
  );

  const totals = buildIntegratedSoldTotals(performances);
  const elapsedPeriod = getElapsedPeriod(
    totals.openedAt,
    totals.closedAt ?? new Date(),
  );
  const totalLine = `Total: ${formatMoneyChange(
    totals.realizedPercentageChange,
    "%",
  )} ${formatMoneyChange(totals.realizedPnl)} (${elapsedPeriod.label})`;

  return [...lines, totalLine].join("\n\n");
}

export async function buildIntegratedDailyPerformanceList({
  positions,
  priceOverrides,
  tickerDecorations,
  tickerLabelPreferences,
  tickerLabelLinks,
  tickerEmojiMappings,
  formatTicker,
}: BuildIntegratedTickerListArgs) {
  if (positions.length === 0) {
    return "";
  }

  const now = new Date();
  const performances = getSortedIntegratedPerformances(
    getSortedIntegratedPositions(positions).map((position) =>
      buildIntegratedPositionPerformance(position, now, priceOverrides),
    ),
    (performance) => performance.position.dailyPnl,
  );

  const lines = buildSeparatedChangeLines(
    performances,
    (performance) => performance.position.dailyPnl,
    (performance) => {
      const { position } = performance;
      const tickerName = formatTickerName(
        position.ticker,
        tickerDecorations,
        tickerLabelPreferences,
        tickerLabelLinks,
        tickerEmojiMappings,
        formatTicker,
      );
      if (position.dailyPnl === null) {
        return `${tickerName} ? ? today`;
      }

      const percentage =
        position.dailyPnlPercentage === null
          ? "?"
          : formatMoneyChange(position.dailyPnlPercentage, "%");
      return `${tickerName} ${percentage} ${formatMoneyChange(position.dailyPnl)} today`;
    },
  );

  const totals = buildIntegratedPortfolioTotals(performances, now);
  const totalLine =
    totals.dailyChange === null
      ? "Total: ? ? today"
      : `Total: ${
          totals.dailyPercentageChange === null
            ? "?"
            : formatMoneyChange(totals.dailyPercentageChange, "%")
        } ${formatMoneyChange(totals.dailyChange)} today`;

  return [...lines, totalLine].join("\n\n");
}

const currencyCodes = new Set([
  "AED",
  "AUD",
  "CAD",
  "CHF",
  "CNH",
  "CNY",
  "CZK",
  "DKK",
  "EUR",
  "GBP",
  "HKD",
  "HUF",
  "ILS",
  "JPY",
  "MXN",
  "NOK",
  "NZD",
  "PLN",
  "SEK",
  "SGD",
  "USD",
  "ZAR",
]);

function formatUtcDate(date: Date) {
  const day = String(date.getUTCDate()).padStart(2, "0");
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  return `${day}.${month}`;
}

function isCurrencyConversionOrder(order: IntegrationOrder) {
  const assetCategory = order.assetCategory?.toUpperCase();
  if (assetCategory === "CASH" || assetCategory === "FOREX") {
    return true;
  }

  const [base, quote] = order.ticker.toUpperCase().split(".");
  return Boolean(
    base && quote && currencyCodes.has(base) && currencyCodes.has(quote),
  );
}

export function isDisplayableOrder(
  order: IntegrationOrder,
): order is IntegrationOrder & { price: number } {
  return order.price !== null && !isCurrencyConversionOrder(order);
}

function getOrderHistoryKey(order: IntegrationOrder) {
  return [
    order.date.toISOString().slice(0, 10),
    order.ticker,
    order.currency,
  ].join(":");
}

function buildIntegratedHistoryGroups(orders: IntegrationOrder[]) {
  const grouped = new Map<
    string,
    {
      date: Date;
      ticker: string;
      currency: string;
      quantity: number;
      total: number;
    }
  >();

  for (const order of orders) {
    if (order.quantity <= 0 || !isDisplayableOrder(order)) {
      continue;
    }

    const key = getOrderHistoryKey(order);
    const group = grouped.get(key) ?? {
      date: order.date,
      ticker: order.ticker,
      currency: order.currency,
      quantity: 0,
      total: 0,
    };
    group.quantity += order.quantity;
    group.total += order.quantity * order.price;
    grouped.set(key, group);
  }

  return [...grouped.values()].sort(
    (groupA, groupB) => groupA.date.getTime() - groupB.date.getTime(),
  );
}

export function buildIntegratedHistory({
  orders,
  tickerDecorations,
  tickerLabelPreferences,
  tickerLabelLinks,
  tickerEmojiMappings,
}: BuildIntegratedHistoryArgs) {
  const sorted = buildIntegratedHistoryGroups(orders);
  if (sorted.length === 0) {
    return "";
  }

  const grouped = new Map<number, string[]>();
  const yearTotals = new Map<number, { total: number; currency: string }>();
  let totalSpent = 0;
  let totalCurrency = "USD";

  for (const group of sorted) {
    const year = group.date.getUTCFullYear();
    const lines = grouped.get(year) ?? [];
    const averagePrice = group.total / group.quantity;
    const tickerName = formatDecoratedTicker(
      group.ticker,
      tickerDecorations,
      tickerLabelPreferences,
      tickerLabelLinks,
      tickerEmojiMappings,
    );
    lines.push(
      `${formatUtcDate(group.date)} ${tickerName} ${group.quantity.toFixed(
        4,
      )} x ${formatMoney(averagePrice, group.currency)} (${formatWholeMoney(
        group.total,
        group.currency,
      )})`,
    );
    grouped.set(year, lines);

    const yearTotal = yearTotals.get(year) ?? {
      total: 0,
      currency: group.currency,
    };
    yearTotal.total += group.total;
    yearTotals.set(year, yearTotal);
    totalSpent += group.total;
    totalCurrency = group.currency;
  }

  const yearBlocks = [...grouped.entries()].map(([year, lines]) => {
    const yearTotal = yearTotals.get(year);
    const header = yearTotal
      ? `${year} - ${formatWholeMoney(yearTotal.total, yearTotal.currency)}`
      : String(year);
    return `${header}\n${lines.join("\n")}`;
  });

  return `${yearBlocks.join("\n\n")}\n\nTotal ${formatWholeMoney(
    totalSpent,
    totalCurrency,
  )}`;
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
