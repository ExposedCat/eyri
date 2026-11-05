import { deepStrictEqual, equal } from "node:assert/strict";
import { Api } from "grammy";
import { buildBotApiUrl } from "./api_url.ts";

Deno.test("widget transport uses production beta while polling and messages stay on stable", async () => {
  const urls: string[] = [];
  const api = new Api("123:test", {
    buildUrl: buildBotApiUrl,
    fetch: (input) => {
      urls.push(String(input));
      return Promise.resolve(Response.json({ ok: true, result: true }));
    },
  });
  await api.getMe();
  const raw = api.raw as unknown as {
    sendWidget(args: { chat_id: number; html: string }): Promise<unknown>;
  };
  await raw.sendWidget({ chat_id: 1, html: "<p>Chart</p>" });
  await api.sendMessage(1, "Photo commands stay on stable");
  await api.getUpdates({ timeout: 0 });
  deepStrictEqual(urls, [
    "https://api.telegram.org/bot123:test/getMe",
    "https://api.telegram.org/beta/bot123:test/sendWidget",
    "https://api.telegram.org/bot123:test/sendMessage",
    "https://api.telegram.org/bot123:test/getUpdates",
  ]);
});

Deno.test("widget URL routing preserves test environments and custom API roots", () => {
  equal(buildBotApiUrl("https://api.telegram.org", "token", "sendWidget", "test"),
    "https://api.telegram.org/beta/bottoken/test/sendWidget");
  equal(buildBotApiUrl("http://localhost:8081", "token", "sendWidget", "prod"),
    "http://localhost:8081/bottoken/sendWidget");
  equal(buildBotApiUrl("https://api.telegram.org/beta", "token", "sendWidget", "prod"),
    "https://api.telegram.org/beta/bottoken/sendWidget");
});
