import { deepStrictEqual, equal, match, ok } from "node:assert/strict";
import { Api, InputFile } from "grammy";
import { richApi, richTextMessage, setupRichMessages } from "./rich.ts";

function harness() {
  const api = new Api("123:test");
  const calls: { method: string; payload: Record<string, unknown> }[] = [];
  api.config.use((_previous, method, payload) => {
    calls.push({
      method,
      payload: payload as unknown as Record<string, unknown>,
    });
    return Promise.resolve({ ok: true, result: { message_id: 100 } }) as never;
  });
  setupRichMessages(api);
  return { api, calls };
}

Deno.test("all text delivery uses one rich message, preserving HTML, long lines, topics, replies and ForceReply", async () => {
  const { api, calls } = harness();
  const text = `${
    '<tg-emoji emoji-id="123">💰</tg-emoji><a href="https://example.com">STOCK</a> '
      .repeat(140)
  }\n\nTotal`;
  await api.sendMessage(-1, text, {
    parse_mode: "HTML",
    message_thread_id: 42,
    reply_parameters: { message_id: 7 },
    reply_markup: { force_reply: true, selective: true },
  });
  equal(calls.length, 1);
  equal(calls[0].method, "sendRichMessage");
  deepStrictEqual(calls[0].payload, {
    chat_id: -1,
    message_thread_id: 42,
    reply_parameters: { message_id: 7 },
    reply_markup: { force_reply: true, selective: true },
    rich_message: richTextMessage(text),
  });
  ok((calls[0].payload.rich_message as { html: string }).html.length > 4096);
  await api.sendMessage(1, "<script> & value\nNext");
  deepStrictEqual(calls[1].payload.rich_message, {
    html: "<p>&lt;script&gt; &amp; value<br>Next</p>",
  });
  await api.editMessageText(1, 100, "<b>Updated</b>", { parse_mode: "HTML" });
  equal(calls[2].method, "editMessageText");
  deepStrictEqual(calls[2].payload.rich_message, {
    html: "<p><b>Updated</b></p>",
  });
});

Deno.test("charts, documents and chart updates use rich media and retain their keyboards", async () => {
  const { api, calls } = harness();
  const file = new InputFile(new Uint8Array([1, 2, 3]), "portfolio.png");
  const keyboard = {
    inline_keyboard: [[{
      text: "Compare",
      callback_data: "chart_compare:123",
    }]],
  };
  await api.sendPhoto(-1, file, { caption: "A & B", reply_markup: keyboard });
  await api.sendDocument(-1, file);
  await api.editMessageMedia(-1, 100, {
    type: "photo",
    media: file,
    caption: "Updated",
  }, { reply_markup: keyboard });
  deepStrictEqual(calls.map((call) => call.method), [
    "sendRichMessage",
    "sendRichMessage",
    "editMessageText",
  ]);
  for (const call of calls) {
    const rich = call.payload.rich_message as {
      html: string;
      media: { media: { media: InputFile } }[];
    };
    equal(rich.media[0].media.media, file);
    equal(call.payload.caption, undefined);
    equal(call.payload.media, undefined);
  }
  match(
    (calls[0].payload.rich_message as { html: string }).html,
    /<img.*<p>A &amp; B<\/p>/s,
  );
  match(
    (calls[1].payload.rich_message as { html: string }).html,
    /<tg-document src="tg:\/\/document\?id=attachment">/,
  );
  deepStrictEqual(calls[2].payload.reply_markup, keyboard);
  await richApi(api).sendRichMessage({
    chat_id: 1,
    rich_message: { html: "<p>Already rich</p>" },
  });
  deepStrictEqual(calls[3].payload.rich_message, {
    html: "<p>Already rich</p>",
  });
});

Deno.test("rich media uploads are serialized as multipart attachments by the installed grammY", async () => {
  let requestBody = "";
  const api = new Api("123:test", {
    fetch: async (_url, init) => {
      const request = new Request("https://example.com", init);
      match(request.headers.get("content-type")!, /multipart\/form-data/);
      requestBody = await request.text();
      return Response.json({ ok: true, result: { message_id: 1 } });
    },
  });
  setupRichMessages(api);
  await api.sendDocument(
    1,
    new InputFile(new TextEncoder().encode("image-bytes"), "portfolio.png"),
  );
  match(requestBody, /name="rich_message"/);
  match(requestBody, /attach:\/\//);
  match(requestBody, /filename="?portfolio.png"?/);
  match(requestBody, /image-bytes/);
});
