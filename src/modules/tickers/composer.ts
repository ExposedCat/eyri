import { Composer } from "grammy";
import type { CustomContext } from "../bot/types.ts";
import { refreshPersistentPrice } from "../database/price.ts";
import { addPosition, deleteLatestPosition } from "../database/user.ts";
import {
  escapeHtml,
  formatTickerDecorations,
  parseDecorateCommand,
  parseLabelCommand,
  parseLinkCommand,
  readTickerDecorations,
  readTickerLabelLinks,
  readTickerLabelPreferences,
  setTickerDecoration,
  setTickerLabelLink,
  setTickerLabelPreference,
} from "./decorations.ts";
import {
  buildHistory,
  buildPerformanceList,
  buildTickerList,
  parsePriceOverrides,
} from "./portfolio.ts";

export const tickersComposer = new Composer<CustomContext>();

const htmlReplyOptions = {
  parse_mode: "HTML" as const,
  link_preview_options: {
    is_disabled: true,
  },
};

tickersComposer.command("buy", async (ctx) => {
  if (!ctx.dbEntities.user) {
    await ctx.text("start");
    return;
  }

  if (!ctx.match) {
    await ctx.text("buy");
    return;
  }

  const params = ctx.match.split(" ");
  if (params.length !== 4) {
    await ctx.text("buy");
    return;
  }

  const [ticker, price, commission, amount] = params;

  const result = await addPosition({
    database: ctx.db,
    userId: ctx.dbEntities.user.userId,
    ticker,
    price: Number(price) + Number(commission),
    amount: Number(amount),
  });

  if (!result.success) {
    await ctx.text("buy");
    return;
  }

  await ctx.text("bought");
  await refreshPersistentPrice(ctx.db, ticker);
});

tickersComposer.command("delete", async (ctx) => {
  if (!ctx.dbEntities.user) {
    await ctx.text("start");
    return;
  }

  if (!ctx.match) {
    await ctx.text("delete");
    return;
  }

  const params = ctx.match.split(" ");
  if (params.length !== 1) {
    await ctx.text("delete");
    return;
  }

  const [ticker] = params;
  const result = await deleteLatestPosition({
    database: ctx.db,
    userId: ctx.dbEntities.user.userId,
    ticker,
  });

  if (!result.success) {
    await ctx.text("delete_not_found");
    return;
  }

  await ctx.text("deleted");
});

tickersComposer.command("decorate", async (ctx) => {
  const parsed = parseDecorateCommand(ctx);
  if (!parsed || !ctx.from) {
    await ctx.text("decorate");
    return;
  }

  await setTickerDecoration(ctx.from.id, parsed.ticker, parsed.decorations);
  await ctx.reply(
    `${formatTickerDecorations(parsed.decorations)} ${escapeHtml(
      parsed.ticker,
    )} decorated (${parsed.decorations.length}).`,
    htmlReplyOptions,
  );
});

tickersComposer.command("label", async (ctx) => {
  const parsed = parseLabelCommand(ctx.match || "");
  if (!parsed || !ctx.from) {
    await ctx.text("label");
    return;
  }

  await setTickerLabelPreference(ctx.from.id, parsed.ticker, parsed.label);
  const labelStatus =
    parsed.label === false ? "hidden" : `set to ${escapeHtml(parsed.label)}`;
  await ctx.reply(
    `${escapeHtml(parsed.ticker)} label ${labelStatus}.`,
    htmlReplyOptions,
  );
});

tickersComposer.command("link", async (ctx) => {
  const parsed = parseLinkCommand(ctx.match || "");
  if (!parsed || !ctx.from) {
    await ctx.text("link");
    return;
  }

  await setTickerLabelLink(ctx.from.id, parsed.ticker, parsed.tag);
  const linkStatus =
    parsed.tag === false ? "removed" : `set to ${escapeHtml(parsed.tag)}`;
  await ctx.reply(
    `${escapeHtml(parsed.ticker)} link ${linkStatus}.`,
    htmlReplyOptions,
  );
});

tickersComposer.command("tickers", async (ctx) => {
  if (!ctx.dbEntities.user || !ctx.from) {
    await ctx.text("start");
    return;
  }

  const tickerDecorations = await readTickerDecorations(ctx.from.id);
  const tickerLabelPreferences = await readTickerLabelPreferences(ctx.from.id);
  const tickerLabelLinks = await readTickerLabelLinks(ctx.from.id);
  const priceList = await buildTickerList({
    database: ctx.db,
    user: ctx.dbEntities.user,
    tickerDecorations,
    tickerLabelPreferences,
    tickerLabelLinks,
  });

  if (priceList.length === 0) {
    await ctx.text("no_positions");
    return;
  }

  await ctx.reply(priceList, htmlReplyOptions);
});

tickersComposer.command("perf", async (ctx) => {
  if (!ctx.dbEntities.user || !ctx.from) {
    await ctx.text("start");
    return;
  }

  const tickerDecorations = await readTickerDecorations(ctx.from.id);
  const tickerLabelPreferences = await readTickerLabelPreferences(ctx.from.id);
  const tickerLabelLinks = await readTickerLabelLinks(ctx.from.id);
  const performanceList = await buildPerformanceList({
    database: ctx.db,
    user: ctx.dbEntities.user,
    tickerDecorations,
    tickerLabelPreferences,
    tickerLabelLinks,
  });

  if (performanceList.length === 0) {
    await ctx.text("no_positions");
    return;
  }

  await ctx.reply(performanceList, htmlReplyOptions);
});

tickersComposer.command("history", async (ctx) => {
  if (!ctx.dbEntities.user || !ctx.from) {
    await ctx.text("start");
    return;
  }

  const tickerDecorations = await readTickerDecorations(ctx.from.id);
  const tickerLabelPreferences = await readTickerLabelPreferences(ctx.from.id);
  const tickerLabelLinks = await readTickerLabelLinks(ctx.from.id);
  const history = buildHistory({
    user: ctx.dbEntities.user,
    tickerDecorations,
    tickerLabelPreferences,
    tickerLabelLinks,
  });

  if (history.length === 0) {
    await ctx.text("no_positions");
    return;
  }

  await ctx.reply(history, htmlReplyOptions);
});

tickersComposer.command("when", async (ctx) => {
  if (!ctx.dbEntities.user || !ctx.from) {
    await ctx.text("start");
    return;
  }

  if (!ctx.match) {
    await ctx.text("when");
    return;
  }

  const priceOverrides = parsePriceOverrides(ctx.match);
  if (!priceOverrides) {
    await ctx.text("when");
    return;
  }

  const tickerDecorations = await readTickerDecorations(ctx.from.id);
  const tickerLabelPreferences = await readTickerLabelPreferences(ctx.from.id);
  const tickerLabelLinks = await readTickerLabelLinks(ctx.from.id);
  const priceList = await buildTickerList({
    database: ctx.db,
    user: ctx.dbEntities.user,
    priceOverrides,
    tickerDecorations,
    tickerLabelPreferences,
    tickerLabelLinks,
  });

  if (priceList.length === 0) {
    await ctx.text("no_positions");
    return;
  }

  await ctx.reply(priceList, htmlReplyOptions);
});
