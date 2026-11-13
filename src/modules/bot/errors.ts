import { getAllIntegrations } from "../database/integration.ts";
import type { CustomContext } from "./types.ts";
import { userErrorMessage } from "../../utils/user_error.ts";

export function logUserError(ctx: CustomContext, error: unknown) {
  const seen = new Set<unknown>();
  function diagnostic(value: unknown): string {
    if (seen.has(value)) return "[already logged]";
    seen.add(value);
    if (!(value instanceof Error)) {
      if (typeof value === "string") return value;
      try {
        return JSON.stringify(value) ?? String(value);
      } catch {
        return String(value);
      }
    }
    let text = value.stack ?? value.message;
    if (value instanceof AggregateError) {
      for (const child of value.errors) {
        text += `\nSource: ${diagnostic(child)}`;
      }
    }
    if (value.cause !== undefined) {
      text += `\nCaused by: ${diagnostic(value.cause)}`;
    }
    return text;
  }
  let detail = diagnostic(error);
  const secrets = [ctx.api.token];
  try {
    if (ctx.db) {
      for (const integration of getAllIntegrations(ctx.db)) {
        for (const [key, value] of Object.entries(integration.credentials)) {
          if (
            /token|key|password|secret/i.test(key) &&
            typeof value === "string" && value
          ) secrets.push(value);
        }
      }
    }
  } catch {
    /* Reporting a database failure must not require a healthy database. */
  }
  for (const secret of secrets) {
    if (secret) detail = detail.replaceAll(secret, "[redacted]");
  }
  console.error(`Report error ${ctx.update.update_id}: ${detail}`);
}

export async function replyUserError(ctx: CustomContext, error: unknown) {
  logUserError(ctx, error);
  let message = "";
  for (
    const line of userErrorMessage(error, String(ctx.update.update_id)).split(
      "\n",
    )
  ) {
    if (message && message.length + line.length > 3900) {
      await ctx.reply(message);
      message = "";
    }
    message += `${message ? "\n" : ""}${line}`;
  }
  if (message) await ctx.reply(message);
}
