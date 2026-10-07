import { Bot as TelegramBot } from "grammy";

import type { Database } from "../database/setup.ts";
import { findOrCreateUser } from "../database/user.ts";
import { integrationsComposer } from "../integrations/composer.ts";
import { startComposer } from "../start/composer.ts";
import { tickersComposer } from "../tickers/composer.ts";
import { chartComposer } from "../tickers/chart_composer.ts";
import type { Bot, CustomContext } from "./types.ts";
import { createReplyWithTextFunc } from "./utils.ts";
import { setupBotRuntime } from "./runtime.ts";

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
  bot.use(integrationsComposer);
  bot.use(tickersComposer);
  bot.use(chartComposer);
}

export function createBot(database: Database): Bot {
  const TOKEN = Deno.env.get("TOKEN");
  if (!TOKEN) {
    throw new Error("TOKEN environment variable is missing");
  }

  const bot = new TelegramBot<CustomContext>(TOKEN);

  setupBotRuntime(bot);
  extendContext(bot, database);
  setupComposers(bot);

  return bot;
}

const botCommands = [
  { command: "start", description: "Show help" },
  { command: "integrations", description: "Manage integration accounts" },
  { command: "t212", description: "Connect a Trading 212 account" },
  { command: "stocks", description: "Show stock performance" },
  { command: "portfolio", description: "Chart stock allocation" },
  { command: "chart", description: "Chart and compare all-time performance" },
  { command: "yahoo", description: "Set a Yahoo symbol for historical prices" },
  { command: "rsu", description: "Show or record RSU vesting" },
  { command: "rsu_rm", description: "Remove RSU awards for a ticker" },
  { command: "rsu_at", description: "Show RSUs with a vesting cutoff date" },
  { command: "options", description: "Show option and warrant performance" },
  { command: "perf", description: "Show concise performance" },
  { command: "number", description: "Show ticker icons and current total gain" },
  { command: "worth", description: "Show current USD value and percentage returns" },
  { command: "worthnumber", description: "Show ticker icons and current total value" },
  {
    command: "alltime",
    description: "Show combined current and sold performance",
  },
  { command: "allnumber", description: "Show ticker icons and all-time total gain" },
  { command: "buckets", description: "Show portfolio buckets" },
  { command: "bucket", description: "Manage portfolio buckets" },
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
