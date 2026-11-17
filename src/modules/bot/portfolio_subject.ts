import type { NextFunction } from "grammy";
import { readUser } from "../database/user.ts";
import { portfolioVisibility } from "../database/visibility.ts";
import { getRsuAwards } from "../database/rsu.ts";
import { hasPortfolioViewIntegrations } from "../tickers/portfolio_view.ts";
import type { CustomContext } from "./types.ts";

const reports = [
  "portfolio",
  "chart",
  "perf",
  "dpnl",
  "alltime",
  "number",
  "allnumber",
  "worth",
  "worthnumber",
  "sold",
  "history",
  "when",
  "buckets",
  "rsu_at",
  "dump_options",
  "dump_tickers",
];

export async function selectPortfolioSubject(
  ctx: CustomContext,
  next: NextFunction,
) {
  const report = ctx.hasCommand(reports) ||
    (ctx.hasCommand("rsu") && !/^\/\S+\s+\S/.test(ctx.message?.text ?? ""));
  const reply = ctx.message?.reply_to_message;
  const subject = reply?.from;
  if (
    report && !ctx.portfolioSubject && ctx.chat && subject && !subject.is_bot &&
    !reply?.sender_chat && subject.id !== ctx.from?.id
  ) {
    const user = readUser(ctx.db, subject.id);
    if (
      user && portfolioVisibility(ctx.db, user.userId, ctx.chat.id) &&
      (hasPortfolioViewIntegrations(ctx.db, user.userId, null) ||
        getRsuAwards(ctx.db, user.userId).length > 0)
    ) {
      ctx.dbEntities.user = user;
      ctx.portfolioSubject = subject;
    }
  }
  await next();
}
