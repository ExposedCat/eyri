import { fetchConversionRates } from "../../utils/exchange_rates.ts";
import { requireReportNumber } from "../../utils/report_value.ts";
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
import { buildReportSnapshot } from "../tickers/report.ts";
import type { ReportKind, ReportFilter } from "../tickers/performance_command.ts";

export const reportDescriptions = {
  number: "Ticker icons' underlying tickers and total for perf, alltime, worth or dpnl, with an optional stocks/options filter, like /number.",
  allnumber:
    "Total realized plus unrealized profit/loss and tickers, like /allnumber.",
  perf: "Open-position profit/loss, percentage returns and holding periods, like /perf.",
  alltime:
    "Lifetime profit/loss and total return on gross deposits. Ticker returns and unallocated bucket returns are unavailable, like /alltime.",
  worth:
    "Current holdings plus cash and portfolio value, like /worth. Filtered views exclude unallocated account cash.",
  worthnumber: "Total current portfolio value and tickers, like /worthnumber.",
  stocks:
    "Stock/CFD positions, prices, quantities, costs, values and monthly returns.",
  options:
    "Option positions, prices, quantities, costs, values and monthly returns.",
  sold: "FIFO realized profit/loss, percentage returns and holding periods, like /sold.",
  dpnl: "Today's position and portfolio profit/loss and percentage returns, like /dpnl.",
  history:
    "Grouped purchases, quantities, prices and spending by year, like /history.",
  when: "Hypothetical open-position returns at target prices in the user's reporting currency, like /when.",
  portfolio:
    "Stock/CFD allocation weights, current values and returns, like /portfolio.",
  chart:
    "Historical perf, alltime or worth from the same reports as text commands, using broker cash and execution history, like /chart, without an image.",
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
  kind?: ReportKind;
  filter?: ReportFilter;
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
  const compactKind = name === "number" ? args.kind ?? "perf" : name === "allnumber" ? "alltime" : name === "worthnumber" ? "worth" : null;
  if (name === "number" && compactKind === "alltime") name = "allnumber";
  if (name === "number" && compactKind === "worth") name = "worthnumber";
  const chartKind = args.kind ?? "alltime";
  if (name === "chart" && chartKind === "dpnl") throw new ReportError("invalid_kind", "Chart supports perf, alltime and worth.");
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
        share: bucket.share,
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
    if (notes.length && (view.upcoming.length || view.total.length || view.missed.length)) {
      throw new Error(notes.join("\n"));
    }
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
  const rawView = await runtime.view(db, user.userId, bucketName, {
    positions: name !== "history" && name !== "sold",
    history: ["alltime", "allnumber", "worth", "worthnumber", "sold", "chart"].includes(name),
    displayHistory: name === "history",
    accountPerformance: !args.filter && ["alltime", "allnumber", "worth", "worthnumber", "chart"].includes(name) && !(name === "chart" && chartKind === "perf"),
  });
  const matches = args.filter === "stocks" ? isStockPosition : args.filter === "options" ? isOptionPosition : () => true;
  const view = { ...rawView, positions: rawView.positions.filter(matches), orders: rawView.orders.filter(matches),
    ...(args.filter ? { accountPerformances: [] } : {}) };
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
      { ...view, kind: chartKind as "perf" | "alltime" | "worth", filter: args.filter },
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
      kind: chartKind,
      notes: dataset.notes ?? [],
      points: dataset.points.map((p) => ({
        date: p.date,
        [chartKind === "worth" ? "value" : "pnl"]: p.gain * rate,
        returnPct: p.percentage,
      })),
    };
  }
  if (compactKind === "dpnl") {
    const snapshot = await buildReportSnapshot(input, "dpnl");
    return { ...context, tickers: snapshot.tickers, total: snapshot.value };
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
    const accounts = report?.accounts.map((account) => ({
      ...account,
      openedAt: account.openedAt.toISOString(),
      historyThrough: account.historyThrough.toISOString(),
    })) ?? [];
    if (name === "allnumber")
      return {
        ...context,
        tickers: performances.map((p) => p.ticker),
        total: report?.total.change ?? null,
        ...(accounts.length ? { accounts } : {}),
      };
    const item = (p: NonNullable<typeof report>["total"]) => ({
      pnl: p.change,
      returnPct: null,
      period: p.openedAt ? getElapsedPeriod(p.openedAt, p.endedAt).label : null,
    });
    return {
      ...context,
      positions: performances.map((p) => ({ ticker: p.ticker, ...item(p) })),
      total: report ? {
        ...item(report.total),
        returnPct: report.totalReturnPercentage,
      } : null,
      ...(report?.returnUnavailableReason ? { returnUnavailableReason: report.returnUnavailableReason } : {}),
      ...(accounts.length ? { accounts } : {}),
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
  const worth = name === "worth" || name === "worthnumber" ? await buildReportSnapshot({ ...input, positions }, "worth") : null;
  if (name === "number" || name === "worthnumber") {
    return {
      ...context,
      tickers: [...new Set(performances.map((p) => p.position.ticker))],
      total: !positions.length && !worth
        ? null
        : name === "number"
          ? totals.totalChange
          : worth!.value,
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
    ...(worth ? { cash: worth.cash } : {}),
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
    total: !positions.length && !worth
      ? null
      : {
          [name === "worth" ? "value" : "pnl"]:
            name === "worth" ? worth!.value : totals.totalChange,
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
