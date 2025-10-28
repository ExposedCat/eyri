import type { Api, Context, NextFunction, Bot as TelegramBot } from "grammy";
import type { Message } from "grammy_types";
import type { Database } from "../database/setup.ts";
import type { User } from "../database/user.ts";
import type { TradenetRealtime } from "../tradernet/realtime.ts";

type Extra = Parameters<Api["sendMessage"]>[2];

export type Custom = {
	text: (
		text: string,
		templateData?: Record<string, string | number>,
		extra?: Extra,
	) => Promise<Message.TextMessage>;

	dbEntities: {
		user: User | null;
	};

	db: Database;
	tradenetRealtime: TradenetRealtime;
};

export type CustomContext = Context & Custom;

export type Bot = TelegramBot<CustomContext>;

export type Handler = (ctx: CustomContext, next?: NextFunction) => void;
