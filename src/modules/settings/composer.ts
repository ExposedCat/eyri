import { Composer } from "grammy";
import type { CustomContext } from "../bot/types.ts";
import { ephemeralMessageId, showRichMessage } from "../bot/rich.ts";
import {
  portfolioVisibility,
  setPortfolioVisibility,
} from "../database/visibility.ts";

function settingsMessage(ctx: CustomContext) {
  const userId = ctx.from!.id;
  const toggle = (scope: "global" | "chat") => {
    const enabled = portfolioVisibility(
      ctx.db,
      userId,
      scope === "chat" ? ctx.chat!.id : undefined,
    );
    return `<tg-button type="callback_data" style="${
      enabled ? "success" : "danger"
    }" data="visibility:${userId}:${scope}:${ctx.chat!.id}">${
      enabled ? "Public" : "Private"
    }</tg-button>`;
  };
  return {
    html: `<p>Visibility ${toggle("global")}</p>\n<p>Chat visibility ${
      toggle("chat")
    }</p>`,
  };
}

export const settingsComposer = new Composer<CustomContext>();

settingsComposer.command("settings", async (ctx) => {
  if (!ctx.chat || !ctx.from) return;
  const ephemeralId = ephemeralMessageId(ctx.message);
  await showRichMessage(ctx, settingsMessage(ctx), false, {
    ...(ctx.chat.type !== "private" &&
      { ephemeral_message_parameters: { receiver_user_id: ctx.from.id } }),
    ...(ephemeralId !== undefined &&
      { reply_parameters: { ephemeral_message_id: ephemeralId } }),
  });
});

settingsComposer.callbackQuery(
  /^visibility:(\d+):(global|chat):(-?\d+)$/,
  async (ctx) => {
    const [, owner, scope, chatId] = ctx.match;
    if (
      !ctx.chat || !ctx.callbackQuery.message ||
      ctx.from.id !== Number(owner) || ctx.chat.id !== Number(chatId)
    ) {
      await ctx.answerCallbackQuery({
        text: "These settings belong to another user or chat.",
      });
      return;
    }
    const targetChat = scope === "chat" ? ctx.chat.id : undefined;
    setPortfolioVisibility(
      ctx.db,
      ctx.from.id,
      !portfolioVisibility(ctx.db, ctx.from.id, targetChat),
      targetChat,
    );
    await showRichMessage(ctx, settingsMessage(ctx), true);
    await ctx.answerCallbackQuery();
  },
);
