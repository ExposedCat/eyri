import { accountWorth } from "./account_return.ts";
import { buildIntegratedAllTimeReport, buildIntegratedPositionReport } from "./portfolio.ts";
import type { ReportKind } from "./performance_command.ts";
import { requireReportNumber } from "../../utils/report_value.ts";

// One endpoint for the full report, icon summary and historical chart.
export async function buildReportSnapshot(
  args: Parameters<typeof buildIntegratedAllTimeReport>[0], kind: ReportKind,
) {
  if (kind === "alltime") {
    const report = await buildIntegratedAllTimeReport(args);
    return { value: report?.total.change ?? 0, percentage: report?.totalReturnPercentage ?? null,
      tickers: report?.performances.map(item => item.ticker) ?? [], cash: 0 };
  }
  const report = await buildIntegratedPositionReport(args, kind === "dpnl");
  const worth = kind === "worth" ? await accountWorth(requireReportNumber(report.currentValue, "current value"),
    new Set(args.positions.map(position => position.integrationId)), args.accountPerformances ?? [], args.currency ?? "USD", args.request) : null;
  return {
    value: worth ? worth.value
      : requireReportNumber(kind === "dpnl" ? report.totals.dailyChange : report.totals.totalChange, "report P/L"),
    percentage: kind === "worth" ? null : kind === "dpnl" ? report.totals.dailyPercentageChange : report.totals.totalPercentageChange,
    tickers: report.performances.map(item => item.position.ticker), cash: worth?.cash ?? 0,
  };
}
