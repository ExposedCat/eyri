import { Composer } from "grammy";
import type { CustomContext } from "../bot/types.ts";
import { escapeHtml } from "../tickers/decorations.ts";
import { getAdminId } from "./access.ts";
import { collectConnectorStatus, type StatusReport } from "./service.ts";
import { richTextMessage, showRichMessage } from "../bot/rich.ts";

const names = { ibkr: "IBKR", t212: "Trading 212", f24: "Freedom24" };
const icons = { healthy: "🟢", degraded: "🟡", offline: "🔴", blocked: "🔴", recovering: "🟡" };
const time = (value: number) => Number.isFinite(value) ? `${new Date(value).toISOString().replace("T", " ").slice(0, 19)} UTC` : "unknown";

export function statusMessages(report: StatusReport) {
  const healthy = report.connectors.filter(connector => connector.state === "healthy").length;
  const header = `<b>Connector status</b> · ${time(report.checkedAt)}\n${report.connectors.length} configured · ${healthy} healthy · ${report.connectors.length - healthy} need attention`;
  const sections = [header];
  for (const connector of report.connectors) {
    const title = `${icons[connector.state]} <b>${names[connector.kind]} #${connector.integrationId}</b> · owner ${connector.ownerId} · ${connector.state.toUpperCase()}`;
    const lines = [title, ...(connector.endpoint ? [`Endpoint: ${escapeHtml(connector.endpoint)}`] : []), ...connector.checks.map(check =>
      `${check.state === "ok" ? "✓" : check.state === "error" ? "✗" : "•"} ${escapeHtml(check.name)}: ${check.state.toUpperCase()}${check.message ? ` — ${escapeHtml(check.message)}` : ""}${check.lastSuccess !== undefined ? `\n  Last success: ${time(check.lastSuccess)}` : ""}${check.nextAttempt !== undefined ? `\n  Next poll no earlier than: ${time(check.nextAttempt)}` : ""}`,
    )];
    sections.push(lines.join("\n"));
  }
  if (!report.connectors.length) sections.push("No broker connectors configured.");
  return [sections.join("\n\n")];
}

type Runtime = { adminId: () => number | undefined; collect: typeof collectConnectorStatus };
export function createStatusComposer(overrides: Partial<Runtime> = {}) {
  const runtime: Runtime = { adminId: getAdminId, collect: collectConnectorStatus, ...overrides };
  const pending = new WeakMap<CustomContext["db"], Promise<StatusReport>>();
  const composer = new Composer<CustomContext>();
  composer.command("status", async ctx => {
    const adminId = runtime.adminId();
    if (!adminId || ctx.from?.id !== adminId) { await ctx.reply("Admin only."); return; }
    if (ctx.chat.type !== "private") { await ctx.reply("Use /status in a private chat with the bot."); return; }
    let request = pending.get(ctx.db);
    if (!request) {
      request = runtime.collect(ctx.db).finally(() => pending.delete(ctx.db));
      pending.set(ctx.db, request);
    }
    try {
      const report = await request;
      await showRichMessage(ctx, richTextMessage(statusMessages(report)[0]));
    } catch {
      await ctx.reply("Unable to collect connector status. Check the application logs.");
    }
  });
  return composer;
}

export const statusComposer = createStatusComposer();
