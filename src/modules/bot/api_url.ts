// Widgets are currently served by Telegram's beta Bot API on production chats.
// Keep polling and all established methods on the stable API. Custom API roots
// retain their own routing, including any explicitly configured beta prefix.
export function buildBotApiUrl(
  root: string,
  token: string,
  method: string,
  environment: "prod" | "test",
): string {
  const beta = root === "https://api.telegram.org" && method === "sendWidget"
    ? "/beta"
    : "";
  const test = environment === "test" ? "test/" : "";
  return `${root}${beta}/bot${token}/${test}${method}`;
}
