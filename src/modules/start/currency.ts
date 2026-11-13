import { Composer } from "grammy";
import { fetchUsdConversionRates } from "../../utils/exchange_rates.ts";
import type { CustomContext } from "../bot/types.ts";
import { setUserCurrency } from "../database/user.ts";
import { replyUserError } from "../bot/errors.ts";

export function createCurrencyComposer(request: typeof fetch = fetch) {
  const composer = new Composer<CustomContext>();
  composer.command("currency", async (ctx) => {
    const user = ctx.dbEntities.user;
    if (!user) return;
    const input = ctx.match.trim().toUpperCase();
    if (!input) {
      await ctx.reply(
        `Your currency: ${
          user.currency ?? "USD"
        }.\nUse /currency CODE to set any supported currency, or /currency USD to reset.`,
      );
      return;
    }
    if (!/^[A-Z]{3}$/.test(input)) {
      await ctx.reply(
        "Use /currency CODE, for example /currency EUR or /currency USD.",
      );
      return;
    }
    try {
      // Use the same rate provider as reports, including GBX pence support.
      await fetchUsdConversionRates([input], request);
      setUserCurrency(ctx.db, user.userId, input === "USD" ? null : input);
      user.currency = input === "USD" ? null : input;
      await ctx.reply(
        `Your currency is now ${input}. Chart comparisons always use USD.`,
      );
    } catch (error) {
      await replyUserError(ctx, error);
    }
  });
  return composer;
}

export const currencyComposer = createCurrencyComposer();
