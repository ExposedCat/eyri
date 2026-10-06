import { Composer, GrammyError } from "grammy";
import type { CustomContext } from "../bot/types.ts";
import { richApi, type RichMessage } from "../bot/rich.ts";
import {
  clearIntegrationSetup,
  createIntegration,
  deleteIntegration,
  getIntegrationSetup,
  getUserIntegrations,
  type Integration,
  type IntegrationKind,
  setIntegrationSetup,
} from "../database/integration.ts";

export const integrationsComposer = new Composer<CustomContext>();

function describeIntegration(integration: Integration) {
  if (integration.kind === "ibkr") {
    const url = String(integration.credentials.instanceUrl ?? "unknown");
    const account = integration.credentials.accountId;
    return `IBKR ${url}${account ? `, account ${account}` : ""}`;
  }
  const key = String(integration.credentials.apiKey ?? "");
  // Never render a complete API key, including unusually short keys.
  const masked = key.length > 8
    ? `${key.slice(0, 4)}…${key.slice(-4)}`
    : "••••";
  return integration.kind === "t212"
    ? `Trading 212 ${masked}`
    : `Freedom24 ${masked}`;
}

export function buildIntegrationsMessage(
  integrations: Integration[],
  userId: number,
): RichMessage {
  return {
    blocks: [
      { type: "heading", text: "Integrations", size: 2 },
      ...integrations.map((integration, index) => ({
        type: "paragraph" as const,
        text: [
          `${index + 1}. ${describeIntegration(integration)}  `,
          {
            type: "button" as const,
            button: {
              text: "Delete",
              style: "danger" as const,
              callback_data: `integration:${userId}:delete:${integration.id}`,
            },
          },
        ],
      })),
      ...(integrations.length
        ? []
        : [{ type: "paragraph" as const, text: "No integrations yet." }]),
      {
        type: "buttons",
        buttons: [{
          text: "Add integration",
          style: "primary",
          callback_data: `integration:${userId}:add`,
        }],
      },
    ],
  };
}

async function showRichMessage(
  ctx: CustomContext,
  richMessage: RichMessage,
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
      // Repeated clicks can request the same menu while it is already shown.
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

async function showIntegrations(ctx: CustomContext, edit = false) {
  const userId = ctx.dbEntities.user?.userId;
  if (!userId) return;
  await showRichMessage(
    ctx,
    buildIntegrationsMessage(getUserIntegrations(ctx.db, userId), userId),
    edit,
  );
}

export function parseIntegrationCredentials(
  kind: IntegrationKind,
  input: string,
): Record<string, unknown> | null {
  const params = input.trim().split(/\s+/);
  if (kind === "ibkr") {
    if (params.length !== 3) return null;
    const [instanceUrl, flexToken, flexQueryId] = params;
    return { instanceUrl, flexToken, flexQueryId };
  }
  if (kind === "t212") {
    if (params.length !== 2) return null;
    const [apiKey, secretKey] = params;
    return { apiKey, secretKey };
  }
  if (params.length !== 2 && params.length !== 3) return null;
  const [apiKey, secretKey, historyYears] = params;
  const years = historyYears === undefined ? 10 : Number(historyYears);
  if (!Number.isFinite(years) || years <= 0) return null;
  return { apiKey, secretKey, historyYears: years };
}

function credentialPrompt(kind: IntegrationKind) {
  if (kind === "t212") {
    return "Send your Trading 212 credentials in this format:\n\n<code>[api_key] [secret_key]</code>\n\nGenerate the key and secret in your live account. Enable read-only Portfolio and History - Orders permissions; leave trading permissions disabled.\n\nUse /cancel to cancel.";
  }
  return kind === "ibkr"
    ? "Send your IBKR credentials in this format:\n\n<code>[instance_url] [flex_token] [flex_query_id]</code>\n\nUse /cancel to cancel."
    : "Send your Freedom24 credentials in this format:\n\n<code>[api_key] [secret_key] [history_years]</code>\n\n<code>history_years</code> is optional and defaults to 10.\n\nUse /cancel to cancel.";
}

integrationsComposer.command("integrations", async (ctx) => {
  if (!ctx.dbEntities.user || !ctx.chat) return;
  clearIntegrationSetup(ctx.db, ctx.dbEntities.user.userId, ctx.chat.id);
  await showIntegrations(ctx);
});

integrationsComposer.callbackQuery(
  /^integration:(\d+):(add|select|delete|back)(?::(ibkr|f24|t212|\d+))?$/,
  async (ctx) => {
    const userId = ctx.dbEntities.user?.userId;
    const [, owner, action, value] = ctx.match;
    if (!userId || Number(owner) !== userId || !ctx.chat) {
      await ctx.answerCallbackQuery({
        text: "This integration menu belongs to another user.",
      });
      return;
    }
    if (action === "delete") {
      const result = await deleteIntegration({
        database: ctx.db,
        userId,
        integrationId: Number(value),
      });
      await ctx.answerCallbackQuery({
        text: result.success
          ? "Integration deleted."
          : "Integration not found.",
      });
      if (!result.success) return;
      await showIntegrations(ctx, true);
      return;
    }
    await ctx.answerCallbackQuery();
    clearIntegrationSetup(ctx.db, userId, ctx.chat.id);
    if (action === "add") {
      await showRichMessage(ctx, {
        blocks: [
          { type: "heading", text: "Add integration", size: 2 },
          { type: "paragraph", text: "Choose a provider." },
          {
            type: "buttons",
            buttons: [
              {
                text: "Freedom24",
                callback_data: `integration:${userId}:select:f24`,
              },
              {
                text: "IBKR",
                callback_data: `integration:${userId}:select:ibkr`,
              },
              {
                text: "Trading 212",
                callback_data: `integration:${userId}:select:t212`,
              },
            ],
          },
          {
            type: "buttons",
            buttons: [{
              text: "Back",
              callback_data: `integration:${userId}:back`,
            }],
          },
        ],
      }, true);
    } else if (
      action === "select" &&
      (value === "ibkr" || value === "f24" || value === "t212")
    ) {
      const prompt = await ctx.reply(credentialPrompt(value), {
        parse_mode: "HTML",
        reply_markup: { force_reply: true, selective: true },
      });
      setIntegrationSetup(
        ctx.db,
        userId,
        ctx.chat.id,
        value,
        prompt.message_id,
      );
    } else {
      await showIntegrations(ctx, true);
    }
  },
);

for (const kind of ["ibkr", "f24", "t212"] as const) {
  integrationsComposer.command(kind, async (ctx) => {
    if (!ctx.dbEntities.user || !ctx.chat) return;
    const userId = ctx.dbEntities.user.userId;
    clearIntegrationSetup(ctx.db, userId, ctx.chat.id);
    const credentials = ctx.match
      ? parseIntegrationCredentials(kind, ctx.match)
      : null;
    if (!credentials) {
      await ctx.text(kind);
      return;
    }
    const result = await createIntegration({
      database: ctx.db,
      userId,
      kind,
      credentials,
    });
    await ctx.text(
      result.success ? "integration_saved" : "integration_save_failed",
    );
  });
}

integrationsComposer.command("integration_delete", async (ctx) => {
  const userId = ctx.dbEntities.user?.userId;
  if (!userId) return;
  const input = ctx.match.trim();
  // Keep the old provider shortcut only when it identifies a single account.
  const integrations = getUserIntegrations(ctx.db, userId);
  const accounts = integrations.filter((item) => item.kind === input);
  const integrationId = /^\d+$/.test(input)
    ? integrations[Number(input) - 1]?.id
    : accounts.length === 1
    ? accounts[0].id
    : null;
  if (!integrationId) {
    await ctx.text("integration_delete");
    return;
  }
  const result = await deleteIntegration({
    database: ctx.db,
    userId,
    integrationId,
  });
  await ctx.text(
    result.success ? "integration_deleted" : "integration_not_found",
  );
});

integrationsComposer.command("cancel", async (ctx) => {
  if (!ctx.dbEntities.user || !ctx.chat) return;
  clearIntegrationSetup(ctx.db, ctx.dbEntities.user.userId, ctx.chat.id);
  await ctx.reply("Integration setup cancelled.");
});

integrationsComposer.on("message:text", async (ctx, next) => {
  const userId = ctx.dbEntities.user?.userId;
  if (!userId || ctx.message.text.startsWith("/")) return next();
  const setup = getIntegrationSetup(ctx.db, userId, ctx.chat.id);
  if (!setup) return next();
  const replyId = ctx.message.reply_to_message?.message_id;
  if (replyId !== undefined && replyId !== setup.promptMessageId) return next();
  const credentials = parseIntegrationCredentials(setup.kind, ctx.message.text);
  if (!credentials) {
    const prompt = await ctx.reply(credentialPrompt(setup.kind), {
      parse_mode: "HTML",
      reply_markup: { force_reply: true, selective: true },
    });
    setIntegrationSetup(
      ctx.db,
      userId,
      ctx.chat.id,
      setup.kind,
      prompt.message_id,
    );
    return;
  }
  const result = await createIntegration({
    database: ctx.db,
    userId,
    kind: setup.kind,
    credentials,
  });
  if (!result.success) {
    await ctx.text("integration_save_failed");
    return;
  }
  clearIntegrationSetup(ctx.db, userId, ctx.chat.id);
  await ctx.text("integration_saved");
  await showIntegrations(ctx);
});
