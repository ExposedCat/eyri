import { type Api, GrammyError, type InputFile } from "grammy";
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
export type InputRichMessage = RichMessage | {
  html: string;
  media?: {
    id: string;
    media: { type: "photo" | "document"; media: string | InputFile };
  }[];
};

export function escapeRichHtml(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(
    ">",
    "&gt;",
  ).replaceAll('"', "&quot;");
}

// Keep every outgoing text, photo and document on the rich-message API, including
// legacy handlers. Preserve reply keyboards, ForceReply, topics and reply targets.
export function setupRichMessages(api: Api) {
  api.config.use((previous, method, payload, signal) => {
    const data = payload as unknown as Record<string, unknown>;
    let target: string = method;
    let converted = data;
    if (
      method === "sendMessage" ||
      (method === "editMessageText" && data.text !== undefined)
    ) {
      const {
        text,
        parse_mode,
        entities: _entities,
        link_preview_options: _preview,
        ...extra
      } = data;
      const html = parse_mode === "HTML"
        ? String(text)
        : escapeRichHtml(String(text));
      converted = { ...extra, rich_message: richTextMessage(html) };
      if (method === "sendMessage") target = "sendRichMessage";
    } else if (
      method === "sendPhoto" || method === "sendDocument" ||
      method === "editMessageMedia"
    ) {
      const {
        photo,
        document,
        media: edited,
        caption,
        parse_mode,
        caption_entities: _entities,
        show_caption_above_media: _above,
        ...extra
      } = data;
      const item = method === "editMessageMedia"
        ? edited as {
          type: string;
          media: unknown;
          caption?: string;
          parse_mode?: string;
        }
        : {
          type: method === "sendPhoto" ? "photo" : "document",
          media: photo ?? document,
          caption: caption as string | undefined,
          parse_mode,
        };
      if (item.type !== "photo" && item.type !== "document") {
        return previous(method, payload, signal);
      }
      const text = item.caption
        ? (item.parse_mode === "HTML"
          ? item.caption
          : escapeRichHtml(item.caption))
        : "";
      converted = {
        ...extra,
        rich_message: {
          html: `${
            item.type === "photo"
              ? '<img src="tg://photo?id=attachment"/>'
              : '<tg-document src="tg://document?id=attachment"></tg-document>'
          }${text ? `\n${richTextMessage(text).html}` : ""}`,
          media: [{
            id: "attachment",
            media: { type: item.type, media: item.media },
          }],
        },
      };
      target = method === "editMessageMedia"
        ? "editMessageText"
        : "sendRichMessage";
    }
    return previous(target as never, converted as never, signal) as never;
  });
}

// Reports already contain escaped Telegram inline HTML. Explicit paragraphs and
// line breaks preserve their layout in rich HTML without the plain-text limit.
export function richTextMessage(text: string): { html: string } {
  return {
    html: text.split(/\n{2,}/).map((paragraph) =>
      `<p>${paragraph.replaceAll("\n", "<br>")}</p>`
    ).join("\n"),
  };
}

export type RichMessageOptions = {
  message_thread_id?: number;
  reply_markup?: unknown;
  reply_parameters?: { message_id?: number; ephemeral_message_id?: number };
  ephemeral_message_parameters?: { receiver_user_id: number };
};

export function ephemeralMessageId(message: unknown): number | undefined {
  return (message as { ephemeral_message_id?: number } | undefined)
    ?.ephemeral_message_id;
}

export function richApi(api: Api) {
  return api.raw as unknown as {
    sendRichMessage(
      payload: {
        chat_id: number;
        rich_message: InputRichMessage;
      } & RichMessageOptions,
    ): Promise<Message>;
    editEphemeralMessageText(payload: {
      chat_id: number;
      receiver_user_id: number;
      ephemeral_message_id: number;
      rich_message: InputRichMessage;
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
  options: RichMessageOptions = {},
) {
  if (!ctx.chat) return;
  const api = richApi(ctx.api);
  if (edit && ctx.callbackQuery?.message) {
    try {
      const ephemeralId = ephemeralMessageId(ctx.callbackQuery.message);
      if (ephemeralId !== undefined) {
        await api.editEphemeralMessageText({
          chat_id: ctx.chat.id,
          receiver_user_id: ctx.from!.id,
          ephemeral_message_id: ephemeralId,
          rich_message: richMessage,
        });
      } else {
        await api.editMessageText({
          chat_id: ctx.chat.id,
          message_id: ctx.callbackQuery.message.message_id,
          rich_message: richMessage,
        });
      }
    } catch (error) {
      // Repeated clicks can request the same content while it is already shown.
      if (
        !(error instanceof GrammyError && error.error_code === 400 &&
          error.description.includes("message is not modified"))
      ) throw error;
    }
  } else {
    return await api.sendRichMessage({
      chat_id: ctx.chat.id,
      rich_message: richMessage,
      message_thread_id: ctx.msg?.message_thread_id,
      ...options,
    });
  }
}
