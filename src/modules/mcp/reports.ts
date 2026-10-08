import { fetchConversionRates } from "../../utils/exchange_rates.ts";
import { getUserBucket, getUserBuckets } from "../database/bucket.ts";
import { getUserIntegrations } from "../database/integration.ts";
import { getRsuAwards } from "../database/rsu.ts";
import type { Database } from "../database/setup.ts";
import { readUser } from "../database/user.ts";
import { describeIntegration } from "../integrations/description.ts";
import { fetchIntegratedIbkrStockQuotes } from "../integrations/ibkr/quotes.ts";
import { conversionFactor } from "../integrations/usd.ts";
import { loadAllTimeDataset } from "../tickers/alltime_chart.ts";
import {
  buildIntegratedAllTimeReport,
  buildIntegratedHistoryReport,
  buildIntegratedPositionReport,
  buildIntegratedSoldReport,
  getElapsedPeriod,
  isOptionPosition,
  isStockPosition,
} from "../tickers/portfolio.ts";
import { buildPortfolioAllocation } from "../tickers/portfolio_chart.ts";
import {
  fetchPortfolioView,
  hasPortfolioViewIntegrations,
} from "../tickers/portfolio_view.ts";
import { buildRsuReport, getRsuView } from "../tickers/rsu.ts";

export const reportDescriptions = {
  number: "Total unrealized profit/loss and tickers, like /number.",
  allnumber:
    "Total realized plus unrealized profit/loss and tickers, like /allnumber.",
  perf: "Open-position profit/loss, percentage returns and holding periods, like /perf.",
  alltime:
    "Realized plus unrealized profit/loss, percentage returns and holding periods, like /alltime.",
  worth:
    "Current position values, percentage returns and holding periods, like /worth.",
  worthnumber: "Total current portfolio value and tickers, like /worthnumber.",
  stocks:
    "Stock/CFD positions, prices, quantities, costs, values and monthly returns, like /stocks.",
  options:
    "Option positions, prices, quantities, costs, values and monthly returns, like /options.",
  sold: "FIFO realized profit/loss, percentage returns and holding periods, like /sold.",
  dpnl: "Today's position and portfolio profit/loss and percentage returns, like /dpnl.",
  history:
    "Grouped purchases, quantities, prices and spending by year, like /history.",
  when: "Hypothetical open-position returns at target prices in the user's reporting currency, like /when.",
  portfolio:
    "Stock/CFD allocation weights, current values and returns, like /portfolio.",
  chart:
    "All-time daily profit/loss and percentage series, like /chart, without an image.",
  buckets:
    "Accessible portfolio buckets, their owners and inclusion flags, like /buckets.",
  integrations:
    "Configured integration IDs and masked descriptions, like /integrations.",
  rsu: "Upcoming RSU vestings, current values, changes and total, like /rsu.",
  rsu_at:
    "RSU vestings through a cutoff date, total and missed vestings, like /rsu_at.",
} as const;
export type ReportName = keyof typeof reportDescriptions;
export type ReportArgs = {
  userId: number;
  bucketName?: string;
  prices?: Record<string, number>;
  cutoff?: string;
};

export class ReportError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

export type ReportRuntime = {
  view: typeof fetchPortfolioView;
  request: typeof fetch;
  rsuQuotes: typeof fetchIntegratedIbkrStockQuotes;
  chart: typeof loadAllTimeDataset;
};
const defaultRuntime: ReportRuntime = {
  view: fetchPortfolioView,
  request: fetch,
  rsuQuotes: fetchIntegratedIbkrStockQuotes,
  chart: loadAllTimeDataset,
};

// Auth is intentionally absent: userId selects an existing Telegram user's data.
export async function runReport(
  db: Database,
  name: ReportName,
  args: ReportArgs,
  runtime: ReportRuntime = defaultRuntime,
): Promise<Record<string, unknown>> {
  const user = readUser(db, args.userId);
  if (!user)
    throw new ReportError(
      "user_not_found",
      "User not found. Use /start in Telegram first.",
    );
  const currency = user.currency ?? "USD";
  const bucketName = args.bucketName ?? null;
  const context = { currency };
  if (name === "buckets") {
    return {
      buckets: getUserBuckets(db, user.userId).map((bucket) => ({
        name: bucket.name,
        ownerUserId: bucket.ownerUserId,
        included: bucket.included,
      })),
    };
  }
  if (name === "integrations") {
    return {
      integrations: getUserIntegrations(db, user.userId).map((integration) => ({
        id: integration.id,
        kind: integration.kind,
        description: describeIntegration(integration),
      })),
    };
  }
  if (name === "rsu" || name === "rsu_at") {
    const now = new Date();
    const awards = getRsuAwards(db, user.userId);
    if (!awards.length)
      return {
        ...context,
        vestings: [],
        total: null,
        notes: [],
        ...(args.cutoff ? { missed: null } : {}),
      };
    const view = getRsuView(awards, now, args.cutoff);
    const integrations = getUserIntegrations(db, user.userId).filter(
      (i) => i.kind === "ibkr",
    );
    const prices = new Map<string, number>();
    const notes: string[] = [];
    if (integrations.length) {
      try {
        const quotes = await runtime.rsuQuotes(
          integrations,
          [...view.upcoming, ...view.total, ...view.missed].map(
            (v) => v.ticker,
          ),
        );
        for (const [ticker, quote] of quotes) {
          if (quote.price !== undefined) prices.set(ticker, quote.price);
          else notes.push(`${ticker}: price unavailable. ${quote.error ?? ""}`);
        }
      } catch (error) {
        notes.push(
          `Prices unavailable: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    } else notes.push("Configure /ibkr to fetch current RSU prices.");
    const rate = conversionFactor(
      "USD",
      await fetchConversionRates(["USD"], currency, runtime.request),
    );
    return {
      ...context,
      ...buildRsuReport(view, prices, now, currency, rate, args.cutoff),
      notes,
    };
  }
  if (bucketName !== null && !getUserBucket(db, user.userId, bucketName)) {
    throw new ReportError(
      "bucket_not_found",
      `Bucket not found: ${bucketName}`,
    );
  }
  if (!hasPortfolioViewIntegrations(db, user.userId, bucketName)) {
    throw new ReportError(
      "no_integrations",
      "No integrations configured for this portfolio.",
    );
  }
  const view = await runtime.view(db, user.userId, bucketName, {
    positions: name !== "history" && name !== "sold",
    history: ["alltime", "allnumber", "sold", "chart"].includes(name),
    displayHistory: name === "history",
  });
  const input = {
    ...view,
    currency,
    request: runtime.request,
    priceOverrides: args.prices
      ? Object.fromEntries(
          Object.entries(args.prices).map(([ticker, price]) => [
            ticker.trim().toUpperCase(),
            price,
          ]),
        )
      : undefined,
  };
  if (name === "chart") {
    const dataset = await runtime.chart(
      db,
      view,
      user.userId,
      String(user.userId),
      undefined,
      runtime.request,
    );
    const rate = conversionFactor(
      "USD",
      await fetchConversionRates(["USD"], currency, runtime.request),
    );
    return {
      ...context,
      points: dataset.points.map((p) => ({
        date: p.date,
        pnl: p.gain * rate,
        returnPct: p.percentage,
      })),
    };
  }
  if (name === "portfolio") {
    const chart = await buildPortfolioAllocation(
      view.positions,
      runtime.request,
      currency,
    );
    return {
      ...context,
      total: chart?.total ?? null,
      holdings:
        chart?.holdings.map((h) => ({
          ticker: h.ticker,
          weightPct: h.weight,
          value: h.value,
          pnl: h.change,
          returnPct: h.returnPct,
        })) ?? [],
    };
  }
  if (name === "history") {
    const { groups } = await buildIntegratedHistoryReport({
      ...input,
      orders: view.historyOrders,
    });
    const years = new Map<
      number,
      { year: number; spent: number; purchases: unknown[] }
    >();
    for (const group of groups) {
      const year = group.date.getUTCFullYear();
      const entry = years.get(year) ?? { year, spent: 0, purchases: [] };
      entry.spent += group.total;
      entry.purchases.push({
        date: group.date.toISOString().slice(0, 10),
        ticker: group.ticker,
        amount: group.quantity,
        price: group.total / group.quantity,
        spent: group.total,
      });
      years.set(year, entry);
    }
    return {
      ...context,
      years: [...years.values()],
      total: groups.length ? groups.reduce((sum, g) => sum + g.total, 0) : null,
    };
  }
  if (name === "alltime" || name === "allnumber") {
    const report = await buildIntegratedAllTimeReport(input);
    const performances = report?.performances ?? [];
    if (name === "allnumber")
      return {
        ...context,
        tickers: performances.map((p) => p.ticker),
        total: report?.total.change ?? null,
      };
    const item = (p: NonNullable<typeof report>["total"]) => ({
      pnl: p.change,
      returnPct:
        p.cost === null || p.change === null
          ? null
          : p.cost === 0
            ? 0
            : (p.change / p.cost) * 100,
      period: p.openedAt ? getElapsedPeriod(p.openedAt, p.endedAt).label : null,
    });
    return {
      ...context,
      positions: performances.map((p) => ({ ticker: p.ticker, ...item(p) })),
      total: report ? item(report.total) : null,
    };
  }
  if (name === "sold") {
    const report = await buildIntegratedSoldReport(input);
    const item = (p: {
      realizedPnl: number;
      realizedPercentageChange: number;
      openedAt: Date | null;
      closedAt: Date | null;
    }) => ({
      pnl: p.realizedPnl,
      returnPct: p.realizedPercentageChange,
      period: p.openedAt
        ? getElapsedPeriod(p.openedAt, p.closedAt ?? new Date()).label
        : null,
    });
    return {
      ...context,
      positions:
        report?.performances.map((p) => ({ ticker: p.ticker, ...item(p) })) ??
        [],
      total: report ? item(report.totals) : null,
    };
  }
  const positions =
    name === "stocks"
      ? view.positions.filter(isStockPosition)
      : name === "options"
        ? view.positions.filter(isOptionPosition)
        : view.positions;
  const report = await buildIntegratedPositionReport(
    { ...input, positions },
    name === "dpnl",
  );
  const { performances, totals } = report;
  if (name === "number" || name === "worthnumber") {
    return {
      ...context,
      tickers: [...new Set(performances.map((p) => p.position.ticker))],
      total: !positions.length
        ? null
        : name === "number"
          ? totals.totalChange
          : report.currentValue,
    };
  }
  if (name === "dpnl") {
    return {
      ...context,
      positions: performances.map(({ position: p }) => ({
        ticker: p.ticker,
        pnl: p.dailyPnl,
        returnPct: p.dailyPnl === null ? null : p.dailyPnlPercentage,
      })),
      total: !positions.length
        ? null
        : { pnl: totals.dailyChange, returnPct: totals.dailyPercentageChange },
    };
  }
  const detailed = ["stocks", "options", "when"].includes(name);
  return {
    ...context,
    positions: performances.map((p) => ({
      ticker: p.position.ticker,
      [name === "worth" ? "value" : "pnl"]:
        name === "worth" ? p.currentValue : p.totalChange,
      returnPct: p.totalPercentageChange,
      period: p.elapsedPeriod.days === null ? null : p.elapsedPeriod.label,
      ...(detailed
        ? {
            amount: p.position.amount,
            averagePrice: p.averageUnitPrice,
            currentPrice: p.currentPrice,
            priceChange: p.currentVsAverageChange,
            cost: p.totalInput,
            value: p.totalNow,
            monthlyPnl:
              p.totalChange === null || p.elapsedPeriod.months === null
                ? null
                : p.totalChange / p.elapsedPeriod.months,
            monthlyReturnPct:
              p.totalPercentageChange === null ||
              p.elapsedPeriod.months === null
                ? null
                : p.totalPercentageChange / p.elapsedPeriod.months,
          }
        : {}),
    })),
    total: !positions.length
      ? null
      : {
          [name === "worth" ? "value" : "pnl"]:
            name === "worth" ? report.currentValue : totals.totalChange,
          returnPct: totals.totalPercentageChange,
          period:
            totals.elapsedPeriod.days === null
              ? null
              : totals.elapsedPeriod.label,
          ...(detailed
            ? {
                monthlyPnl: totals.monthlyChange,
                monthlyReturnPct: totals.monthlyPercentageChange,
              }
            : {}),
        },
  };
}
