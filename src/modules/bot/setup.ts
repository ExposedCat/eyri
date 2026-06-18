import { Bot as TelegramBot } from "grammy";

import type { Database } from "../database/setup.ts";
import { findOrCreateUser } from "../database/user.ts";
import { startComposer } from "../start/composer.ts";
import { tickersComposer } from "../tickers/composer.ts";
import type { Bot, CustomContext } from "./types.ts";
import { createReplyWithTextFunc } from "./utils.ts";

function extendContext(bot: Bot, database: Database) {
  bot.use(async (ctx, next) => {
    if (!ctx.chat || !ctx.from) {
      return;
    }

    ctx.text = createReplyWithTextFunc(ctx);
    ctx.db = database;

    const user = await findOrCreateUser(database, ctx.from.id);

    ctx.dbEntities = { user };

    await next();
  });
}

function setupComposers(bot: Bot) {
  bot.use(startComposer);
  bot.use(tickersComposer);
}

export function createBot(database: Database): Bot {
  const TOKEN = Deno.env.get("TOKEN");
  if (!TOKEN) {
    throw new Error("TOKEN environment variable is missing");
  }

  const bot = new TelegramBot<CustomContext>(TOKEN);

  extendContext(bot, database);
  setupComposers(bot);

  return bot;
}

const botCommands = [
  { command: "start", description: "Show help" },
  { command: "stocks", description: "Show stock performance" },
  { command: "options", description: "Show option performance" },
  { command: "perf", description: "Show concise performance" },
  { command: "sold", description: "Show sold position performance" },
  { command: "dpnl", description: "Show daily PnL" },
  { command: "history", description: "Show order history" },
  { command: "when", description: "Preview performance at target prices" },
  { command: "decorate", description: "Decorate a ticker" },
  { command: "label", description: "Set or hide a ticker label" },
  { command: "link", description: "Link a ticker label" },
  { command: "restart", description: "Restart IB Gateway" },
] as const;

export async function setupBotCommands(bot: Bot) {
  await bot.api.setMyCommands(botCommands);
}
