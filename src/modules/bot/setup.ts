import { Bot as TelegramBot } from "grammy";

import type { Database } from "../database/setup.ts";
import { findOrCreateUser } from "../database/user.ts";
import { startComposer } from "../start/composer.ts";
import { tickersComposer } from "../tickers/composer.ts";
import type { TradenetRealtime } from "../tradernet/realtime.ts";
import type { Bot, CustomContext } from "./types.ts";
import { createReplyWithTextFunc } from "./utils.ts";

function extendContext(
	bot: Bot,
	database: Database,
	tradenetRealtime: TradenetRealtime,
) {
	bot.use(async (ctx, next) => {
		if (!ctx.chat || !ctx.from) {
			return;
		}

		ctx.text = createReplyWithTextFunc(ctx);
		ctx.db = database;
		ctx.tradenetRealtime = tradenetRealtime;

		const user = await findOrCreateUser(database, ctx.from.id);

		ctx.dbEntities = { user };

		await next();
	});
}

function setupComposers(bot: Bot) {
	bot.use(startComposer);
	bot.use(tickersComposer);
}

export function createBot(
	database: Database,
	tradenetRealtime: TradenetRealtime,
): Bot {
	const TOKEN = Deno.env.get("TOKEN");
	if (!TOKEN) {
		throw new Error("TOKEN environment variable is missing");
	}

	const bot = new TelegramBot<CustomContext>(TOKEN);

	extendContext(bot, database, tradenetRealtime);
	setupComposers(bot);

	return bot;
}
