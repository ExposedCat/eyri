import { Composer, InlineKeyboard, InputFile } from "grammy";
import { fetchConversionRates } from "../../utils/exchange_rates.ts";
import type { CustomContext } from "../bot/types.ts";
import { selectPortfolioSubject } from "../bot/portfolio_subject.ts";
import { logUserError, replyUserError } from "../bot/errors.ts";
import { withIbkrReportRecovery } from "../bot/ibkr_report.ts";
import { httpError, userErrorMessage } from "../../utils/user_error.ts";
import type { Database } from "../database/setup.ts";
import { HistoricalDataError } from "../market_data/errors.ts";
import { yahooOptionContract } from "../market_data/options.ts";
import { dayAfter, fetchYahooHistory } from "../market_data/yahoo.ts";
import {
  removeYahooMapping,
  saveYahooMapping,
} from "../market_data/mappings.ts";
import { escapeHtml } from "./decorations.ts";
import { getUserBucket } from "../database/bucket.ts";
import { fetchPortfolioView, hasPortfolioViewIntegrations } from "./portfolio_view.ts";
import {
  type AllTimeDataset,
  ensureChartSchema,
  hasChartBenchmarkInputs,
  loadAllTimeDataset,
  renderAllTimeChart,
  selectedChartBenchmark,
  switchChartBenchmarks,
} from "./alltime_chart.ts";
import { CHART_BENCHMARKS, chartBenchmarkIndex } from "./chart_benchmark.ts";
import type { ReportFilter } from "./performance_command.ts";
import { chartUsage, chartWindowStart, clipChartDataset, parseChartArgs } from "./chart_command.ts";
import { reconcileHistory } from "./history_reconciliation.ts";
import { isOptionPosition, isStockPosition } from "./portfolio.ts";
import { renderChartWidget } from "./chart_widget.ts";
import { chartComparisonNotes, requireVisibleChart } from "./chart_points.ts";

type Session = {
  id: string;
  chat_id: string;
  message_id: string | null;
  datasets: string;
};
const MAX_PARTICIPANTS = 6;
const buttons = (
  id: string,
  datasets: AllTimeDataset[],
  isPrivate: boolean,
  compareLabel = "Compare",
  indexLabel?: string,
) => {
  const index = selectedChartBenchmark(datasets);
  const keyboard = new InlineKeyboard();
  if (!isPrivate && datasets.length < MAX_PARTICIPANTS) {
    keyboard.text(compareLabel, `chart_compare:${id}`);
  }
  return datasets.some(hasChartBenchmarkInputs)
    ? keyboard.text(indexLabel ?? CHART_BENCHMARKS[index].name, `chart_index:${id}:${index}`)
    : keyboard;
};
const pending = new Set<string>();

function telegramError(error: unknown, code: number, description = "") {
  return error !== null && typeof error === "object" && "error_code" in error &&
    error.error_code === code && (!description ||
      "description" in error && String(error.description).includes(description));
}

async function datasetFor(ctx: CustomContext, bucketName: string | null,
  selection: { kind: "perf" | "alltime" | "worth"; filter: ReportFilter } = { kind: "alltime", filter: null }) {
  const userId = ctx.dbEntities.user!.userId;
  if (!hasPortfolioViewIntegrations(ctx.db, userId, bucketName)) {
    throw new Error(
      "Configure an integration before charting your all-time performance.",
    );
  }
  return reconcileHistory(async refreshHistory => {
  const view = await fetchPortfolioView(ctx.db, userId, bucketName, {
    refreshHistory, recentHistory: true, retryHistory: false,
    history: true, accountPerformance: true, warrantQuotes: selection.filter !== "stocks",
    accountPerformanceOptions: selection.kind !== "worth" ? { purpose: "benchmark" } : undefined,
    gatewayRecovery: ctx.ibkrReportRecovery,
  });
  const matches = selection.filter === "stocks" ? isStockPosition : selection.filter === "options" ? isOptionPosition : () => true;
  const subject = ctx.portfolioSubject ?? ctx.from!;
  const label = [subject.first_name, subject.last_name].filter(Boolean)
    .join(" ").slice(0, 60);
  return loadAllTimeDataset(
    ctx.db,
    { ...view, positions: view.positions.filter(matches), orders: view.orders.filter(matches),
      accountPerformances: selection.filter ? [] : view.accountPerformances,
      benchmarkSource: { ...view, orders: view.historyOrders, unavailableReason: view.fundingErrors?.join("\n") || undefined }, ...selection },
    userId,
    label,
  );
  });
}

export function readChartSession(
  db: Database,
  id: string,
  chatId: number,
  messageId: number,
) {
  ensureChartSchema(db);
  const row = db.prepare(
    "SELECT id,chat_id,message_id,datasets FROM alltime_chart_sessions WHERE id = ?",
  ).get(id) as Session | undefined;
  return row && row.chat_id === String(chatId) &&
      row.message_id === String(messageId)
    ? row
    : null;
}

type Runtime = {
  dataset: typeof datasetFor;
  render: typeof renderAllTimeChart;
  switchBenchmarks?: typeof switchChartBenchmarks;
  validateSymbol?: (symbol: string, ticker?: string) => Promise<void>;
  request?: typeof fetch;
};

async function validateSymbol(symbol: string, ticker?: string) {
  const today = new Date().toISOString().slice(0, 10);
  const option = yahooOptionContract(symbol);
  const history = await fetchYahooHistory(
    symbol,
    option ? "1970-01-01" : dayAfter(today, -7),
    option && option.expiry < today ? dayAfter(option.expiry) : dayAfter(today),
  );
  if (
    yahooOptionContract(ticker ?? symbol) && history.instrumentType !== "OPTION"
  ) throw new Error("Not an option contract.");
  if (!history.bars.length) throw new Error("No historical data.");
}

async function replyChartError(ctx: CustomContext, error: unknown) {
  if (!(error instanceof HistoricalDataError)) {
    await replyUserError(ctx, error);
    return;
  }
  logUserError(ctx, error);
  let message = "Failed to fetch historical data:";
  for (const failure of error.failures) {
    const detail = failure.cause === undefined
      ? `History not found. Check /yahoo ${failure.ticker} ${failure.symbol}.`
      : userErrorMessage(failure.cause, String(ctx.update.update_id));
    const line = `\n${failure.ticker}: ${detail}`;
    message += line;
  }
  await ctx.reply(message, await ctx.ibkrReportRecovery?.replyOptions());
}

function chartCaption(datasets: AllTimeDataset[]): string | undefined {
  const notes = datasets.flatMap(dataset => (dataset.notes ?? []).map(note => {
    const concise = /^(Index hidden:|Award dates missing;|Currency P\/L excluded|Using saved |.*affected dates are gaps|.*Affected dates are gaps|Cash history has gaps|Foreign-currency fees excluded|Live valuation missing|.*display conversion unavailable)/.test(note) ? note
      : note.startsWith("Gift receipt dates") ? "Award dates missing; shares start today. Enable Grant Activity in Flex."
      : note.startsWith("Benchmark unavailable:") ? `Index hidden: ${userErrorMessage(new Error(note))}`
      : userErrorMessage(new Error(note));
    return datasets.length > 1 ? `${dataset.label}: ${concise}` : concise;
  }));
  const messages = [...chartComparisonNotes(datasets), ...notes.filter(note => note.includes("Index hidden:")), ...notes];
  return messages.length ? [...new Set(messages)].join("\n").slice(0, 1000) : undefined;
}
export function createChartComposer(
  runtime: Runtime = { dataset: datasetFor, render: renderAllTimeChart },
) {
  const composer = new Composer<CustomContext>();
  composer.use(selectPortfolioSubject);
  composer.command("yahoo", async (ctx) => {
    if (!ctx.dbEntities.user || !ctx.from) return;
    const parts = typeof ctx.match === "string"
      ? ctx.match.trim().toUpperCase().split(/\s+/)
      : [];
    const [ticker, symbol] = parts;
    if (
      parts.length !== 2 || !/^[+A-Z0-9][A-Z0-9._^=:+-]{0,63}$/.test(ticker) ||
      (symbol !== "-" && !/^[A-Z0-9^][A-Z0-9._^=+-]{0,63}$/.test(symbol))
    ) {
      await ctx.reply(
        "Use <code>/yahoo TICKER MAPPING</code> to set a Yahoo symbol, or <code>/yahoo TICKER -</code> to reset it.",
        { parse_mode: "HTML" },
      );
      return;
    }
    if (symbol === "-") {
      removeYahooMapping(ctx.db, ticker);
      await ctx.reply(`Global Yahoo mapping removed for ${ticker}.`);
      return;
    }
    try {
      await (runtime.validateSymbol ?? validateSymbol)(symbol, ticker);
    } catch (cause) {
      const status = cause instanceof Error ? cause.message.match(/HTTP (\d{3})/) : null;
      await replyChartError(ctx, new HistoricalDataError([{ ticker, symbol,
        cause: status ? httpError(`Yahoo symbol ${symbol}`, Number(status[1]), "Check the symbol and retry.") : cause }]));
      return;
    }
    saveYahooMapping(ctx.db, ticker, symbol);
    await ctx.reply(
      `Global Yahoo mapping saved: <code>${escapeHtml(ticker)} → ${
        escapeHtml(symbol)
      }</code>. Run /chart to rebuild.`,
      { parse_mode: "HTML" },
    );
  });
  composer.command("chart", withIbkrReportRecovery, async (ctx) => {
    if (!ctx.dbEntities.user || !ctx.from || !ctx.chat) return;
    const selection = parseChartArgs(ctx.match);
    if (!selection) {
      await ctx.reply(chartUsage);
      return;
    }
    const { bucketName } = selection;
    if (
      bucketName &&
      (!/^[A-Za-z][A-Za-z0-9_]{0,19}$/.test(bucketName) ||
        !getUserBucket(ctx.db, ctx.dbEntities.user.userId, bucketName))
    ) {
      await ctx.reply(`Bucket not found. ${chartUsage}`);
      return;
    }
    try {
      let dataset = await runtime.dataset(ctx, bucketName, { kind: "alltime", filter: selection.filter });
      if (selection.window) dataset = clipChartDataset(dataset,
        chartWindowStart(dataset.points.at(-1)!.date, selection.window), dataset.points.at(-1)!.date);
      const currency = ctx.dbEntities.user.currency ?? "USD";
      if (currency !== "USD") {
        try {
          const rates = await fetchConversionRates(["USD"], currency, runtime.request);
          dataset.displayCurrency = currency;
          dataset.displayRate = rates.get("USD")!;
        } catch (error) {
          logUserError(ctx, error);
          (dataset.notes ??= []).push(`${currency} display conversion unavailable; showing USD.`);
        }
      }
      if (selection.widget) {
        const switchBenchmarks = runtime.switchBenchmarks ?? switchChartBenchmarks;
        const [momentum] = await switchBenchmarks(ctx.db, [dataset], "momentum");
        const [sp500] = await switchBenchmarks(ctx.db, [dataset], "sp500");
        const html = renderChartWidget(dataset, sp500.benchmark!, momentum.benchmark!);
        // grammY's raw API proxy supports new Bot API methods before its types
        // catch up. Use the existing API client and its configured transformers.
        const api = ctx.api.raw as unknown as {
          sendWidget(args: { chat_id: number; html: string; height: number; is_shared: boolean; message_thread_id?: number }): Promise<unknown>;
        };
        const topic = ctx.message?.is_topic_message ? { message_thread_id: ctx.message.message_thread_id } : {};
        try {
          await ctx.ibkrReportRecovery?.replyOptions();
          await api.sendWidget({ chat_id: ctx.chat.id, html, height: 0, is_shared: true, ...topic });
        } catch (error) {
          if (telegramError(error, 400, "INPUT_MEDIA_WIDGET_NOT_ALLOWED")) {
            throw new Error("Telegram is not allowing widgets in this chat yet. Use /chart for the photo chart.");
          }
          if (telegramError(error, 404)) {
            throw new Error("HTML chart widgets require Bot API 10.4 support on this bot's API endpoint. Use /chart for the photo chart.");
          }
          throw error;
        }
        return;
      }
      requireVisibleChart([dataset]);
      const image = await runtime.render(ctx.db, [dataset]);
      ensureChartSchema(ctx.db);
      const id = crypto.randomUUID();
      ctx.db.prepare(
        "INSERT INTO alltime_chart_sessions(id,chat_id,datasets) VALUES (?,?,?)",
      ).run(id, String(ctx.chat.id), JSON.stringify([dataset]));
      try {
        const message = await ctx.replyWithPhoto(
          new InputFile(image, "alltime.png"),
          { ...await ctx.ibkrReportRecovery?.replyOptions(), caption: chartCaption([dataset]), reply_markup: buttons(id, [dataset], ctx.chat.type === "private") },
        );
        ctx.db.prepare(
          "UPDATE alltime_chart_sessions SET message_id = ? WHERE id = ?",
        ).run(String(message.message_id), id);
      } catch (error) {
        ctx.db.prepare("DELETE FROM alltime_chart_sessions WHERE id = ?").run(
          id,
        );
        throw error;
      }
    } catch (error) {
      await replyChartError(ctx, error);
    }
  });
  composer.callbackQuery(/^chart_(compare|index):([0-9a-f-]{36})(?::(sp500|momentum))?$/, async (ctx) => {
    const switching = ctx.match[1] === "index";
    const id = ctx.match[2];
    const messageId = ctx.callbackQuery.message?.message_id;
    if (!ctx.chat || !ctx.from || !messageId) {
      await ctx.answerCallbackQuery({ text: "Chart message is inaccessible. Open the original chart.", show_alert: true });
      return;
    }
    if (ctx.callbackQuery.message?.photo && !("rich_message" in ctx.callbackQuery.message)) {
      await ctx.answerCallbackQuery({ text: "This chart uses an older message format. Run /chart again.", show_alert: true });
      return;
    }
    if (!switching && ctx.chat.type === "private") {
      await ctx.answerCallbackQuery({ text: "Compare needs a group chat. Create a chart in the group.", show_alert: true });
      return;
    }
    const session = readChartSession(ctx.db, id, ctx.chat.id, messageId);
    if (!session) {
      const saved = ctx.db.prepare("SELECT id FROM alltime_chart_sessions WHERE id=?").get(id);
      await ctx.answerCallbackQuery({ text: saved
        ? "This is a chart copy. Open the original message."
        : "Saved chart is missing. Run /chart again.", show_alert: true });
      return;
    }
    if (pending.has(id)) {
      await ctx.answerCallbackQuery({ text: "This chart is updating. Please wait." });
      return;
    }
    const datasets = JSON.parse(session.datasets) as AllTimeDataset[];
    if (datasets.some((dataset) => dataset.fundingReturnVersion !== 6)) {
      await ctx.answerCallbackQuery({
        text: "Saved chart uses an old calculation. Run /chart again.",
        show_alert: true,
      });
      return;
    }
    const current = selectedChartBenchmark(datasets);
    if (switching) {
      if (ctx.match[3] !== current) {
        await ctx.answerCallbackQuery({ text: "The index has already changed. Use the updated button." });
        return;
      }
      if (!datasets.some(hasChartBenchmarkInputs)) {
        await ctx.answerCallbackQuery({
          text: datasets.find(dataset => !dataset.benchmark || !dataset.benchmarkPurchases)?.notes?.find(note => note.startsWith("Index hidden:"))?.slice(0, 190)
            ?? "Saved index details are missing. Run /chart again.",
          show_alert: true,
        });
        return;
      }
    } else {
      if (datasets.some((d) => d.userId === ctx.from.id)) {
        await ctx.answerCallbackQuery({ text: "You are already on this chart. Use your existing curve.", show_alert: true });
        return;
      }
      if (datasets.length >= MAX_PARTICIPANTS) {
        await ctx.answerCallbackQuery({ text: "Six-portfolio limit reached. Create another chart.", show_alert: true });
        return;
      }
    }
    const isPrivate = ctx.chat.type === "private";
    // Share one lock between Compare and index changes, claimed before any await.
    pending.add(id);
    try {
      await ctx.answerCallbackQuery();
      const name = [ctx.from.first_name, ctx.from.last_name].filter(Boolean).join(" ").slice(0, 60);
      await ctx.editMessageReplyMarkup({
        reply_markup: buttons(id, datasets, isPrivate,
          switching ? "Compare" : `Adding ${name}...`, switching ? "Switching..." : undefined),
      });
      let next: AllTimeDataset[];
      const switchBenchmarks = runtime.switchBenchmarks ?? switchChartBenchmarks;
      if (switching) {
        next = await switchBenchmarks(ctx.db, datasets, current === "sp500" ? "momentum" : "sp500");
      } else {
        // Only the clicker's accounts are fetched; existing curves and purchase
        // schedules remain the snapshots their owners chose to publish.
        const added = await runtime.dataset(ctx, null, { kind: datasets[0].kind ?? "alltime", filter: datasets[0].filter ?? null });
        const original = datasets[0].points;
        const start = original[0].date;
        const end = original.at(-1)!.date;
        next = [...datasets, added].map((dataset) => {
          const { displayCurrency: _currency, displayRate: _rate, ...usdDataset } = dataset;
          return clipChartDataset(usdDataset, start, end, !!datasets[0].dateRange);
        });
        const joining = next.at(-1)!;
        if (hasChartBenchmarkInputs(joining) && (!joining.benchmark || chartBenchmarkIndex(joining.benchmark.symbol) !== current)) {
          try {
            const [aligned] = await switchBenchmarks(ctx.db, [joining], current);
            next[next.length - 1] = aligned;
          } catch (error) {
            logUserError(ctx, error);
            next[next.length - 1] = { ...joining, benchmark: undefined, benchmarkInputsReady: true, benchmarkIndex: current,
              benchmarkSnapshots: { ...joining.benchmarkSnapshots, ...(joining.benchmark ? { [chartBenchmarkIndex(joining.benchmark.symbol)]: joining.benchmark } : {}) },
              notes: [...(joining.notes ?? []).filter(note => !note.startsWith("Index hidden:")), `Index hidden: ${userErrorMessage(error)}`] };
          }
        }
      }
      requireVisibleChart(next);
      const image = await runtime.render(ctx.db, next);
      await ctx.editMessageMedia({ type: "photo", media: new InputFile(image, "alltime.png"), caption: chartCaption(next) }, {
        reply_markup: buttons(id, next, isPrivate),
      });
      ctx.db.prepare("UPDATE alltime_chart_sessions SET datasets = ? WHERE id = ?")
        .run(JSON.stringify(next), id);
    } catch (error) {
      try {
        await ctx.editMessageReplyMarkup({ reply_markup: buttons(id, datasets, isPrivate) });
      } catch (restoreError) {
        console.error("Failed to restore chart buttons:", restoreError);
      }
      await replyChartError(ctx, error);
    } finally {
      pending.delete(id);
    }
  });
  return composer;
}
export const chartComposer = createChartComposer();
