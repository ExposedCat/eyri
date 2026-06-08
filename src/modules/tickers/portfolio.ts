import { formatMoneyChange } from "../../utils/money.ts";
import type {
  IntegrationOrder,
  IntegrationPortfolioPosition,
} from "../integrations/types.ts";
import {
  formatDecoratedTicker,
  type TickerDecorations,
  type TickerLabelLinks,
  type TickerLabelPreferences,
} from "./decorations.ts";

type BuildIntegratedTickerListArgs = {
  positions: IntegrationPortfolioPosition[];
  priceOverrides?: Record<string, number>;
  tickerDecorations?: TickerDecorations;
  tickerLabelPreferences?: TickerLabelPreferences;
  tickerLabelLinks?: TickerLabelLinks;
};

type BuildIntegratedHistoryArgs = {
  orders: IntegrationOrder[];
  tickerDecorations?: TickerDecorations;
  tickerLabelPreferences?: TickerLabelPreferences;
  tickerLabelLinks?: TickerLabelLinks;
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
  if (!startDate) {
    return {
      months: null,
      label: "?",
    };
  }

  const months = getElapsedMonthCount(startDate, endDate);
  return {
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

function buildIntegratedPositionPerformance(
  position: IntegrationPortfolioPosition,
  now: Date,
  priceOverrides?: Record<string, number>,
): IntegratedPositionPerformance {
  const currentPrice = getPriceOverride(priceOverrides, position.ticker) ??
    position.currentPrice;
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
  const totalPercentageChange = totalInput === 0
    ? 0
    : (totalChange / totalInput) * 100;

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
      monthlyChange: null,
      monthlyPercentageChange: null,
      elapsedPeriod,
    };
  }

  const totalChange = totals.totalNow - totals.totalInput;
  const totalPercentageChange = totals.totalInput === 0
    ? 0
    : (totalChange / totals.totalInput) * 100;

  return {
    ...totals,
    totalChange,
    totalPercentageChange,
    monthlyChange: elapsedPeriod.months === null
      ? null
      : totalChange / elapsedPeriod.months,
    monthlyPercentageChange: elapsedPeriod.months === null
      ? null
      : totalPercentageChange / elapsedPeriod.months,
    elapsedPeriod,
  };
}

export async function buildIntegratedTickerList({
  positions,
  priceOverrides,
  tickerDecorations,
  tickerLabelPreferences,
  tickerLabelLinks,
}: BuildIntegratedTickerListArgs) {
  if (positions.length === 0) {
    return "";
  }

  const now = new Date();
  const performances = getSortedIntegratedPositions(positions).map((position) =>
    buildIntegratedPositionPerformance(position, now, priceOverrides)
  );

  const tickerLines = performances.map((performance) => {
    const { position } = performance;
    const tickerName = formatDecoratedTicker(
      position.ticker,
      tickerDecorations,
      tickerLabelPreferences,
      tickerLabelLinks,
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

    const monthlySummary = performance.elapsedPeriod.months === null
      ? "? ?/m"
      : `${
        formatMoneyChange(
          performance.totalChange / performance.elapsedPeriod.months,
        )
      } ${
        formatMoneyChange(
          performance.totalPercentageChange / performance.elapsedPeriod.months,
          "%",
        )
      }/m`;

    return [
      `${tickerName} ${formatMoneyChange(performance.totalChange)} ${
        formatMoneyChange(
          performance.totalPercentageChange,
          "%",
        )
      }`,
      `${formatMoney(performance.averageUnitPrice, position.currency)} x ${
        formatAmount(
          position.amount,
        )
      } (${formatMoney(performance.currentPrice, position.currency)} ${
        formatMoneyChange(
          performance.currentVsAverageChange,
        )
      })`,
      `${formatMoney(performance.totalInput, position.currency)} -> ${
        formatMoney(
          performance.totalNow,
          position.currency,
        )
      } x ${performance.elapsedPeriod.label} (${monthlySummary})`,
    ].join("\n");
  });

  const totals = buildIntegratedPortfolioTotals(performances, now);
  const totalSummary = totals.totalChange === null ||
      totals.totalPercentageChange === null ||
      totals.monthlyChange === null ||
      totals.monthlyPercentageChange === null
    ? `? ? / ? ? (${totals.elapsedPeriod.label})`
    : `${formatMoneyChange(totals.totalChange)} ${
      formatMoneyChange(
        totals.totalPercentageChange,
        "%",
      )
    } / ${formatMoneyChange(totals.monthlyChange)} ${
      formatMoneyChange(
        totals.monthlyPercentageChange,
        "%",
      )
    } (${totals.elapsedPeriod.label})`;

  return [...tickerLines, totalSummary].join("\n\n");
}

export async function buildIntegratedPerformanceList({
  positions,
  priceOverrides,
  tickerDecorations,
  tickerLabelPreferences,
  tickerLabelLinks,
}: BuildIntegratedTickerListArgs) {
  if (positions.length === 0) {
    return "";
  }

  const now = new Date();
  const performances = getSortedIntegratedPositions(positions).map((position) =>
    buildIntegratedPositionPerformance(position, now, priceOverrides)
  );

  const lines = performances.map((performance) => {
    const { position } = performance;
    const tickerName = formatDecoratedTicker(
      position.ticker,
      tickerDecorations,
      tickerLabelPreferences,
      tickerLabelLinks,
    );
    if (
      performance.totalChange === null ||
      performance.totalPercentageChange === null
    ) {
      return `${tickerName} ? ? (${performance.elapsedPeriod.label})`;
    }

    return `${tickerName} ${
      formatMoneyChange(
        performance.totalPercentageChange,
        "%",
      )
    } ${
      formatMoneyChange(
        performance.totalChange,
      )
    } (${performance.elapsedPeriod.label})`;
  });

  const totals = buildIntegratedPortfolioTotals(performances, now);
  const totalLine =
    totals.totalChange === null || totals.totalPercentageChange === null
      ? `Total: ? ? (${totals.elapsedPeriod.label})`
      : `Total: ${formatMoneyChange(totals.totalPercentageChange, "%")} ${
        formatMoneyChange(
          totals.totalChange,
        )
      } (${totals.elapsedPeriod.label})`;

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
    if (
      order.quantity <= 0 ||
      order.price === null ||
      isCurrencyConversionOrder(order)
    ) {
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
    );
    lines.push(
      `${formatUtcDate(group.date)} ${tickerName} ${
        group.quantity.toFixed(
          4,
        )
      } x ${formatMoney(averagePrice, group.currency)} (${
        formatWholeMoney(
          group.total,
          group.currency,
        )
      })`,
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

  return `${yearBlocks.join("\n\n")}\n\nTotal ${
    formatWholeMoney(
      totalSpent,
      totalCurrency,
    )
  }`;
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
