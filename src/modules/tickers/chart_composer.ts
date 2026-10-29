import { Composer, InlineKeyboard, InputFile } from "grammy";
import { fetchConversionRates } from "../../utils/exchange_rates.ts";
import type { CustomContext } from "../bot/types.ts";
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
  loadAllTimeDataset,
  renderAllTimeChart,
  switchChartBenchmarks,
} from "./alltime_chart.ts";
import { CHART_BENCHMARKS, chartBenchmarkIndex } from "./chart_benchmark.ts";
import { parseReportArgs, type ReportFilter } from "./performance_command.ts";
import { isOptionPosition, isStockPosition } from "./portfolio.ts";

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
  const index = chartBenchmarkIndex(datasets[0].benchmark?.symbol);
  const keyboard = new InlineKeyboard();
  if (!isPrivate && datasets.length < MAX_PARTICIPANTS) {
    keyboard.text(compareLabel, `chart_compare:${id}`);
  }
  return datasets.every(dataset => dataset.benchmark)
    ? keyboard.text(indexLabel ?? CHART_BENCHMARKS[index].name, `chart_index:${id}:${index}`)
    : keyboard;
};
const pending = new Set<string>();

async function datasetFor(ctx: CustomContext, bucketName: string | null,
  selection: { kind: "perf" | "alltime" | "worth"; filter: ReportFilter } = { kind: "alltime", filter: null }) {
  const userId = ctx.from!.id;
  if (!hasPortfolioViewIntegrations(ctx.db, userId, bucketName)) {
    throw new Error(
      "Configure an integration before charting your all-time performance.",
    );
  }
  const view = await fetchPortfolioView(ctx.db, userId, bucketName, { history: true, accountPerformance: true });
  const matches = selection.filter === "stocks" ? isStockPosition : selection.filter === "options" ? isOptionPosition : () => true;
  const label = [ctx.from!.first_name, ctx.from!.last_name].filter(Boolean)
    .join(" ").slice(0, 60);
  return loadAllTimeDataset(
    ctx.db,
    { ...view, positions: view.positions.filter(matches), orders: view.orders.filter(matches),
      accountPerformances: selection.filter ? [] : view.accountPerformances,
      benchmarkSource: view, ...selection },
    userId,
    label,
  );
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
    await ctx.reply(error instanceof Error ? error.message : String(error));
    return;
  }
  let message = "Failed to fetch historical data:";
  for (const command of error.commands) {
    const line = `\n- <code>${escapeHtml(command)}</code>`;
    if (message.length + line.length > 3900) {
      await ctx.reply(message, { parse_mode: "HTML" });
      message = "Failed to fetch historical data:";
    }
    message += line;
  }
  await ctx.reply(message, { parse_mode: "HTML" });
}
export function createChartComposer(
  runtime: Runtime = { dataset: datasetFor, render: renderAllTimeChart },
) {
  const composer = new Composer<CustomContext>();
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
    } catch {
      await replyChartError(ctx, new HistoricalDataError([{ ticker, symbol }]));
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
  composer.command("chart", async (ctx) => {
    if (!ctx.dbEntities.user || !ctx.from || !ctx.chat) return;
    const selection = parseReportArgs(ctx.match, "alltime");
    if (!selection) {
      await ctx.reply("Use /chart [perf|alltime|worth] [s/o/stocks/options] [BUCKET].");
      return;
    }
    const { bucketName } = selection;
    if (
      bucketName &&
      (!/^[A-Za-z][A-Za-z0-9_]{0,19}$/.test(bucketName) ||
        !getUserBucket(ctx.db, ctx.from.id, bucketName))
    ) {
      await ctx.reply("Bucket not found. Use /chart [perf|alltime|worth] [s/o/stocks/options] [BUCKET].");
      return;
    }
    try {
      const dataset = await runtime.dataset(ctx, bucketName, { kind: selection.kind as "perf" | "alltime" | "worth", filter: selection.filter });
      const currency = ctx.dbEntities.user.currency ?? "USD";
      if (currency !== "USD") {
        const rates = await fetchConversionRates(["USD"], currency, runtime.request);
        dataset.displayCurrency = currency;
        dataset.displayRate = rates.get("USD")!;
      }
      const image = await runtime.render(ctx.db, [dataset]);
      ensureChartSchema(ctx.db);
      const id = crypto.randomUUID();
      ctx.db.prepare(
        "INSERT INTO alltime_chart_sessions(id,chat_id,datasets) VALUES (?,?,?)",
      ).run(id, String(ctx.chat.id), JSON.stringify([dataset]));
      try {
        const message = await ctx.replyWithPhoto(
          new InputFile(image, "alltime.png"),
          { reply_markup: buttons(id, [dataset], ctx.chat.type === "private") },
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
    if (!ctx.chat || (!switching && ctx.chat.type === "private") || !ctx.from || !messageId) {
      await ctx.answerCallbackQuery({ text: "This chart is unavailable.", show_alert: true });
      return;
    }
    const session = readChartSession(ctx.db, id, ctx.chat.id, messageId);
    if (!session) {
      await ctx.answerCallbackQuery({ text: "This chart is unavailable in this chat.", show_alert: true });
      return;
    }
    if (pending.has(id)) {
      await ctx.answerCallbackQuery({ text: "This chart is updating. Please wait." });
      return;
    }
    const datasets = JSON.parse(session.datasets) as AllTimeDataset[];
    if (datasets.some((dataset) => dataset.fundingReturnVersion !== 3)) {
      await ctx.answerCallbackQuery({
        text: "This chart uses an older return calculation. Create a new chart with /chart.",
        show_alert: true,
      });
      return;
    }
    const current = chartBenchmarkIndex(datasets[0].benchmark?.symbol);
    if (switching) {
      if (ctx.match[3] !== current) {
        await ctx.answerCallbackQuery({ text: "The index has already changed. Use the updated button." });
        return;
      }
      if (datasets.some((dataset) => !dataset.benchmark || !dataset.benchmarkPurchases)) {
        await ctx.answerCallbackQuery({
          text: "This chart predates index switching. Create a new chart with /chart.",
          show_alert: true,
        });
        return;
      }
    } else {
      if (datasets.some((d) => d.userId === ctx.from.id)) {
        await ctx.answerCallbackQuery({ text: "Your all-time performance is already on this chart.", show_alert: true });
        return;
      }
      if (datasets.length >= MAX_PARTICIPANTS) {
        await ctx.answerCallbackQuery({ text: "This chart already has six portfolios.", show_alert: true });
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
          const points = dataset.points.filter((point) => point.date >= start && point.date <= end);
          if (!points.length) throw new Error("Your portfolio has no performance history within this chart's date range.");
          const clip = (benchmark: NonNullable<AllTimeDataset["benchmark"]>) => ({
            ...benchmark,
            points: benchmark.points.filter((point) => point.date >= start && point.date <= end),
          });
          const benchmark = dataset.benchmark && clip(dataset.benchmark);
          const benchmarkSnapshots = dataset.benchmarkSnapshots && Object.fromEntries(
            Object.entries(dataset.benchmarkSnapshots).map(([index, snapshot]) => [index, clip(snapshot)]),
          );
          return { ...usdDataset, points, benchmark, ...(benchmarkSnapshots && { benchmarkSnapshots }) };
        });
        if (next.at(-1)!.benchmark && chartBenchmarkIndex(next.at(-1)!.benchmark?.symbol) !== current) {
          const [added] = await switchBenchmarks(ctx.db, [next.at(-1)!], current);
          next[next.length - 1] = added;
        }
      }
      const image = await runtime.render(ctx.db, next);
      await ctx.editMessageMedia({ type: "photo", media: new InputFile(image, "alltime.png") }, {
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
