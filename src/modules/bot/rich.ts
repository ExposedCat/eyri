import { type Api, GrammyError } from "grammy";
import type { Message } from "grammy_types";
import type { CustomContext } from "./types.ts";

// Bot API 10.3 rich messages. The installed grammY predates these types;
// its raw API proxy forwards the method and payload unchanged.
export type RichButton = {
  text: string;
  style?: "danger" | "success" | "primary" | "link";
  callback_data: string;
};
type RichText = string | (string | { type: "button"; button: RichButton })[];
export type RichMessage = {
  blocks: (
    | { type: "heading"; text: string; size: number }
    | { type: "paragraph"; text: RichText }
    | { type: "buttons"; buttons: RichButton[] }
  )[];
};
// Rich HTML keeps existing Telegram HTML (links, custom emoji) and adds
// inline <tg-button> controls.
export type InputRichMessage = RichMessage | { html: string };

export function richApi(api: Api) {
  return api.raw as unknown as {
    sendRichMessage(payload: {
      chat_id: number;
      rich_message: InputRichMessage;
      message_thread_id?: number;
    }): Promise<Message>;
    editMessageText(payload: {
      chat_id: number;
      message_id: number;
      rich_message: InputRichMessage;
    }): Promise<Message | true>;
  };
}

// Edits the message whose button was pressed, otherwise sends a new message.
export async function showRichMessage(
  ctx: CustomContext,
  richMessage: InputRichMessage,
  edit = false,
) {
  if (!ctx.chat) return;
  const api = richApi(ctx.api);
  if (edit && ctx.callbackQuery?.message) {
    try {
      await api.editMessageText({
        chat_id: ctx.chat.id,
        message_id: ctx.callbackQuery.message.message_id,
        rich_message: richMessage,
      });
    } catch (error) {
      // Repeated clicks can request the same content while it is already shown.
      if (
        !(error instanceof GrammyError && error.error_code === 400 &&
          error.description.includes("message is not modified"))
      ) throw error;
    }
  } else {
    await api.sendRichMessage({
      chat_id: ctx.chat.id,
      rich_message: richMessage,
      message_thread_id: ctx.msg?.message_thread_id,
    });
  }
}
