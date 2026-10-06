import type { Api } from "grammy";
import type { Message } from "grammy_types";

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

export function richApi(api: Api) {
  return api.raw as unknown as {
    sendRichMessage(payload: {
      chat_id: number;
      rich_message: RichMessage;
      message_thread_id?: number;
    }): Promise<Message>;
    editMessageText(payload: {
      chat_id: number;
      message_id: number;
      rich_message: RichMessage;
    }): Promise<Message | true>;
  };
}
