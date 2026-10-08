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
} from "./alltime_chart.ts";

type Session = {
  id: string;
  chat_id: string;
  message_id: string | null;
  datasets: string;
};
const MAX_PARTICIPANTS = 6;
const button = (id: string) =>
  new InlineKeyboard().text("Compare", `chart_compare:${id}`);
const pending = new Map<string, Promise<unknown>>();

async function datasetFor(ctx: CustomContext, bucketName: string | null) {
  const userId = ctx.from!.id;
  if (!hasPortfolioViewIntegrations(ctx.db, userId, bucketName)) {
    throw new Error(
      "Configure an integration before charting your all-time performance.",
    );
  }
  const view = await fetchPortfolioView(ctx.db, userId, bucketName, { history: true, accountPerformance: true });
  const label = [ctx.from!.first_name, ctx.from!.last_name].filter(Boolean)
    .join(" ").slice(0, 60);
  return loadAllTimeDataset(
    ctx.db,
    view,
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
    const bucketName = typeof ctx.match === "string" && ctx.match.trim()
      ? ctx.match.trim()
      : null;
    if (
      bucketName &&
      (!/^[A-Za-z][A-Za-z0-9_]{0,19}$/.test(bucketName) ||
        !getUserBucket(ctx.db, ctx.from.id, bucketName))
    ) {
      await ctx.reply("Bucket not found. Use /chart or /chart BUCKET.");
      return;
    }
    try {
      const dataset = await runtime.dataset(ctx, bucketName);
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
          { reply_markup: button(id) },
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
  composer.callbackQuery(/^chart_compare:([0-9a-f-]{36})$/, async (ctx) => {
    const id = ctx.match[1];
    const messageId = ctx.callbackQuery.message?.message_id;
    if (!ctx.chat || !ctx.from || !messageId) {
      await ctx.answerCallbackQuery({
        text: "This chart is unavailable.",
        show_alert: true,
      });
      return;
    }
    const session = readChartSession(ctx.db, id, ctx.chat.id, messageId);
    if (!session) {
      await ctx.answerCallbackQuery({
        text: "This chart is unavailable in this chat.",
        show_alert: true,
      });
      return;
    }
    const datasets = JSON.parse(session.datasets) as AllTimeDataset[];
    if (datasets.some((d) => d.userId === ctx.from.id)) {
      await ctx.answerCallbackQuery({
        text: "Your all-time performance is already on this chart.",
        show_alert: true,
      });
      return;
    }
    if (datasets.length >= MAX_PARTICIPANTS) {
      await ctx.answerCallbackQuery({
        text: "This chart already has six portfolios.",
        show_alert: true,
      });
      return;
    }
    await ctx.answerCallbackQuery();
    const previous = pending.get(id) ?? Promise.resolve();
    const task = previous.catch(() => {}).then(async () => {
      const current = readChartSession(ctx.db, id, ctx.chat!.id, messageId);
      if (!current) return;
      const existing = JSON.parse(current.datasets) as AllTimeDataset[];
      if (
        existing.length >= MAX_PARTICIPANTS ||
        existing.some((d) => d.userId === ctx.from.id)
      ) return;
      // Existing curves are the snapshots their owners chose to publish. Only
      // the clicker's accounts are fetched; another user's credentials are never used here.
      const next = [...existing, await runtime.dataset(ctx, null)].map((dataset) => {
        const { displayCurrency: _currency, displayRate: _rate, ...usdDataset } = dataset;
        return usdDataset;
      });
      const image = await runtime.render(ctx.db, next);
      await ctx.editMessageMedia({
        type: "photo",
        media: new InputFile(image, "alltime.png"),
      }, {
        reply_markup: next.length < MAX_PARTICIPANTS
          ? button(id)
          : { inline_keyboard: [] },
      });
      ctx.db.prepare(
        "UPDATE alltime_chart_sessions SET datasets = ? WHERE id = ?",
      ).run(JSON.stringify(next), id);
    }).catch(async (error) => {
      await replyChartError(ctx, error);
    });
    pending.set(id, task);
    try {
      await task;
    } finally {
      if (pending.get(id) === task) pending.delete(id);
    }
  });
  return composer;
}
export const chartComposer = createChartComposer();
