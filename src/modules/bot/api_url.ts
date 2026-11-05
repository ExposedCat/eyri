// Widgets are currently served by Telegram's beta Bot API on production chats.
// Keep polling and ordinary messages on the stable API. Widget forwards also
// use beta so the returned message retains its widget metadata. Custom API roots
// retain their own routing, including any explicitly configured beta prefix.
export function buildBotApiUrl(
  root: string,
  token: string,
  method: string,
  environment: "prod" | "test",
): string {
  const beta = root === "https://api.telegram.org" && (method === "sendWidget" || method === "forwardMessage")
    ? "/beta"
    : "";
  const test = environment === "test" ? "test/" : "";
  return `${root}${beta}/bot${token}/${test}${method}`;
}
