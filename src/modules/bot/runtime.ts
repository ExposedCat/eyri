import { run, sequentialize } from "grammy_runner";
import type { Bot } from "./types.ts";

const reportCommands = [
  "start",
  "stocks",
  "options",
  "portfolio",
  "chart",
  "perf",
  "alltime",
  "number",
  "allnumber",
  "sold",
  "dpnl",
  "history",
  "when",
  "buckets",
  "rsu_at",
  "dump_options",
  "dump_tickers",
];

export function setupBotRuntime(bot: Bot) {
  bot.use(async (ctx, next) => {
    const updateId = ctx.update.update_id;
    const startedAt = Date.now();
    console.log(`Handling update ${updateId}`);
    const timer = setTimeout(() => {
      console.warn(`Update ${updateId} is still running after 30 seconds`);
    }, 30_000);
    try {
      await next();
    } finally {
      clearTimeout(timer);
      console.log(`Finished update ${updateId} in ${Date.now() - startedAt}ms`);
    }
  });
  bot.use(
    sequentialize((ctx) => {
      if (!ctx.from || ctx.hasCommand(reportCommands)) return [];
      if (ctx.hasCommand("rsu") && !/^\S+\s+\S/.test(ctx.message?.text ?? "")) {
        return [];
      }
      if (ctx.callbackQuery?.data?.startsWith("chart_compare:")) return [];
      return [`user:${ctx.from.id}`];
    }),
  );
  bot.catch(({ ctx, error }) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(
      `Failed to handle update ${ctx.update.update_id}:`,
      message.replaceAll(bot.token, "[redacted]"),
    );
  });
}

export function runBot(bot: Bot) {
  return run(bot, {
    sink: { concurrency: 16 },
    runner: { fetch: { allowed_updates: ["message", "callback_query"] } },
  });
}
