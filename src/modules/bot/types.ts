import type { Api, Bot as TelegramBot, Context, NextFunction } from "grammy";
import type { Message, User as TelegramUser } from "grammy_types";
import type { Database } from "../database/setup.ts";
import type { User } from "../database/user.ts";
import type { ReportGatewayRecovery } from "../integrations/ibkr/recovery.ts";

type Extra = Parameters<Api["sendMessage"]>[2];
type ReportReplyOptions = Pick<NonNullable<Extra>, "message_thread_id" | "reply_parameters">;

export type Custom = {
  portfolioSubject?: TelegramUser;
  ibkrReportRecovery?: ReportGatewayRecovery & {
    replyOptions: () => Promise<ReportReplyOptions | undefined>;
  };
  text: (
    text: string,
    templateData?: Record<string, string | number>,
    extra?: Extra,
  ) => Promise<Message.TextMessage>;

  dbEntities: {
    user: User | null;
  };

  db: Database;
};

export type CustomContext = Context & Custom;

export type Bot = TelegramBot<CustomContext>;

export type Handler = (ctx: CustomContext, next?: NextFunction) => void;
