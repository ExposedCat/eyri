import { Composer } from "grammy";
import type { CustomContext } from "../bot/types.ts";
import {
  deleteIntegration,
  getUserIntegrations,
  hasUserIntegrations,
  type IntegrationKind,
  upsertIntegration,
} from "../database/integration.ts";
import {
  fetchIntegratedOrderHistory,
  fetchIntegratedPortfolio,
} from "../integrations/service.ts";
import {
  escapeHtml,
  formatTickerDecorations,
  parseDecorateCommand,
  parseLabelCommand,
  parseLinkCommand,
  readTickerDecorations,
  readTickerEmojiMappings,
  readTickerLabelLinks,
  readTickerLabelPreferences,
  setTickerDecoration,
  setTickerLabelLink,
  setTickerLabelPreference,
} from "./decorations.ts";
import { removeTickerEmojiPack, syncTickerEmojiPack } from "./emoji_pack.ts";
import {
  buildIntegratedDailyPerformanceList,
  buildIntegratedHistory,
  buildIntegratedPerformanceList,
  buildIntegratedTickerList,
  formatOptionTicker,
  isOptionPosition,
  isStockPosition,
  parsePriceOverrides,
} from "./portfolio.ts";

export const tickersComposer = new Composer<CustomContext>();

const htmlReplyOptions = {
  parse_mode: "HTML" as const,
  link_preview_options: {
    is_disabled: true,
  },
};

function parseIbkrCredentials(input: string) {
  const params = input.trim().split(/\s+/);
  if (params.length !== 3) {
    return null;
  }

  const [instanceUrl, flexToken, flexQueryId] = params;

  return {
    instanceUrl,
    flexToken,
    flexQueryId,
  };
}

function parseFreedom24Credentials(input: string) {
  const params = input.trim().split(/\s+/);
  if (params.length !== 2 && params.length !== 3) {
    return null;
  }

  const [apiKey, secretKey, historyYears] = params;
  if (historyYears !== undefined) {
    const parsedHistoryYears = Number(historyYears);
    if (!Number.isFinite(parsedHistoryYears) || parsedHistoryYears <= 0) {
      return null;
    }
  }

  return {
    apiKey,
    secretKey,
    ...(historyYears === undefined
      ? {}
      : { historyYears: Number(historyYears) }),
  };
}

async function readTickerDisplayPreferences(userId: number) {
  const [tickerDecorations, tickerLabelPreferences, tickerLabelLinks] =
    await Promise.all([
      readTickerDecorations(userId),
      readTickerLabelPreferences(userId),
      readTickerLabelLinks(userId),
    ]);
  const tickerEmojiMappings = await readTickerEmojiMappings();

  return {
    tickerDecorations,
    tickerLabelPreferences,
    tickerLabelLinks,
    tickerEmojiMappings,
  };
}

function formatIntegrationList(
  integrations: ReturnType<typeof getUserIntegrations>,
) {
  return integrations
    .map((integration) => {
      if (integration.kind === "ibkr") {
        const instanceUrl =
          typeof integration.credentials.instanceUrl === "string"
            ? integration.credentials.instanceUrl
            : "unknown";
        const accountId =
          typeof integration.credentials.accountId === "string"
            ? `, account ${escapeHtml(integration.credentials.accountId)}`
            : "";
        return `${integration.id}. IBKR ${escapeHtml(instanceUrl)}${accountId}`;
      }

      if (integration.kind === "f24") {
        const apiKey =
          typeof integration.credentials.apiKey === "string"
            ? integration.credentials.apiKey
            : "unknown";
        const maskedApiKey =
          apiKey.length > 8
            ? `${apiKey.slice(0, 4)}...${apiKey.slice(-4)}`
            : apiKey;
        return `${integration.id}. Freedom24 ${escapeHtml(maskedApiKey)}`;
      }

      return `${integration.id}. ${escapeHtml(integration.kind)}`;
    })
    .join("\n");
}

function createTickerFormatter({
  tickerDecorations,
  tickerLabelPreferences,
  tickerLabelLinks,
  tickerEmojiMappings,
}: Awaited<ReturnType<typeof readTickerDisplayPreferences>>) {
  return (ticker: string) =>
    formatOptionTicker(
      ticker,
      tickerDecorations,
      tickerLabelPreferences,
      tickerLabelLinks,
      tickerEmojiMappings,
    );
}

function formatPackSyncResult(
  action: "created" | "synced",
  result: Awaited<ReturnType<typeof syncTickerEmojiPack>>,
) {
  const parts = [
    `Emoji pack ${action}: ${escapeHtml(result.packName)}`,
    `Tickers: ${result.totalTickers}`,
    `Added: ${result.added.length}`,
    `Skipped: ${result.skipped.length}`,
  ];

  if (result.errors.length > 0) {
    parts.push(
      `Errors: ${result.errors.length}`,
      `<code>${escapeHtml(result.errors.slice(0, 10).join("\n"))}</code>`,
    );
  }

  parts.push(`https://t.me/addemoji/${escapeHtml(result.packName)}`);

  return parts.join("\n");
}

function toDumpablePosition(position: unknown) {
  return JSON.parse(
    JSON.stringify(position, (_key, value) =>
      value instanceof Date ? value.toISOString() : value,
    ),
  );
}

async function replyJsonDump(ctx: CustomContext, value: unknown) {
  const json = JSON.stringify(value, null, 2);
  const maxChunkLength = 3_500;
  for (
    let index = 0;
    index < json.length || index === 0;
    index += maxChunkLength
  ) {
    await ctx.reply(
      `<code>${escapeHtml(json.slice(index, index + maxChunkLength))}</code>`,
      htmlReplyOptions,
    );
  }
}

async function replyIntegrationError(ctx: CustomContext, error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  await ctx.reply(
    `Failed to fetch integration data:\n\n<code>${escapeHtml(message)}</code>`,
    htmlReplyOptions,
  );
}

tickersComposer.command("integrations", async (ctx) => {
  if (!ctx.dbEntities.user) {
    await ctx.text("start");
    return;
  }

  const integrations = getUserIntegrations(ctx.db, ctx.dbEntities.user.userId);
  if (integrations.length === 0) {
    await ctx.text("no_integrations");
    return;
  }

  await ctx.reply(formatIntegrationList(integrations), htmlReplyOptions);
});

tickersComposer.command("ibkr", async (ctx) => {
  if (!ctx.dbEntities.user) {
    await ctx.text("start");
    return;
  }

  if (!ctx.match) {
    await ctx.text("ibkr");
    return;
  }

  const credentials = parseIbkrCredentials(ctx.match);
  if (!credentials) {
    await ctx.text("ibkr");
    return;
  }

  const result = await upsertIntegration({
    database: ctx.db,
    userId: ctx.dbEntities.user.userId,
    kind: "ibkr",
    credentials,
  });
  if (!result.success) {
    await ctx.text("integration_save_failed");
    return;
  }

  await ctx.text("integration_saved");
});

tickersComposer.command("f24", async (ctx) => {
  if (!ctx.dbEntities.user) {
    await ctx.text("start");
    return;
  }

  if (!ctx.match) {
    await ctx.text("f24");
    return;
  }

  const credentials = parseFreedom24Credentials(ctx.match);
  if (!credentials) {
    await ctx.text("f24");
    return;
  }

  const result = await upsertIntegration({
    database: ctx.db,
    userId: ctx.dbEntities.user.userId,
    kind: "f24",
    credentials,
  });
  if (!result.success) {
    await ctx.text("integration_save_failed");
    return;
  }

  await ctx.text("integration_saved");
});

tickersComposer.command("restart", async (ctx) => {
  if (!ctx.dbEntities.user) {
    await ctx.text("start");
    return;
  }

  try {
    await ctx.reply("Restarting eyri...");
    const output = await new Deno.Command("pm3", {
      args: ["restart", "eyri"],
    }).output();

    if (!output.success) {
      const error = new TextDecoder().decode(output.stderr).trim();
      await ctx.reply(
        `Restart failed:\n\n<code>${escapeHtml(
          error || `pm3 exited with code ${output.code}`,
        )}</code>`,
        htmlReplyOptions,
      );
      return;
    }
  } catch (error) {
    await replyIntegrationError(ctx, error);
  }
});

tickersComposer.command("integration_delete", async (ctx) => {
  if (!ctx.dbEntities.user) {
    await ctx.text("start");
    return;
  }

  const kind = ctx.match?.trim() as IntegrationKind | undefined;
  if (kind !== "ibkr" && kind !== "f24") {
    await ctx.text("integration_delete");
    return;
  }

  const result = await deleteIntegration({
    database: ctx.db,
    userId: ctx.dbEntities.user.userId,
    kind,
  });
  if (!result.success) {
    await ctx.text("integration_not_found");
    return;
  }

  await ctx.text("integration_deleted");
});

tickersComposer.command("decorate", async (ctx) => {
  const parsed = parseDecorateCommand(ctx);
  if (!parsed || !ctx.from) {
    await ctx.text("decorate");
    return;
  }

  await setTickerDecoration(ctx.from.id, parsed.ticker, parsed.decorations);
  await ctx.reply(
    `${formatTickerDecorations(parsed.decorations)} ${escapeHtml(
      parsed.ticker,
    )} decorated (${parsed.decorations.length}).`,
    htmlReplyOptions,
  );
});

tickersComposer.command("label", async (ctx) => {
  const parsed = parseLabelCommand(ctx.match || "");
  if (!parsed || !ctx.from) {
    await ctx.text("label");
    return;
  }

  await setTickerLabelPreference(ctx.from.id, parsed.ticker, parsed.label);
  const labelStatus =
    parsed.label === false ? "hidden" : `set to ${escapeHtml(parsed.label)}`;
  await ctx.reply(
    `${escapeHtml(parsed.ticker)} label ${labelStatus}.`,
    htmlReplyOptions,
  );
});

tickersComposer.command("link", async (ctx) => {
  const parsed = parseLinkCommand(ctx.match || "");
  if (!parsed || !ctx.from) {
    await ctx.text("link");
    return;
  }

  await setTickerLabelLink(ctx.from.id, parsed.ticker, parsed.tag);
  const linkStatus =
    parsed.tag === false ? "removed" : `set to ${escapeHtml(parsed.tag)}`;
  await ctx.reply(
    `${escapeHtml(parsed.ticker)} link ${linkStatus}.`,
    htmlReplyOptions,
  );
});

tickersComposer.command("createpack", async (ctx) => {
  if (!ctx.dbEntities.user || !ctx.from) {
    await ctx.text("start");
    return;
  }

  try {
    const result = await syncTickerEmojiPack({
      api: ctx.api,
      database: ctx.db,
      ownerUserId: ctx.from.id,
      recreate: true,
    });
    await ctx.reply(formatPackSyncResult("created", result), htmlReplyOptions);
  } catch (error) {
    await replyIntegrationError(ctx, error);
  }
});

tickersComposer.command("syncpack", async (ctx) => {
  if (!ctx.dbEntities.user || !ctx.from) {
    await ctx.text("start");
    return;
  }

  try {
    const result = await syncTickerEmojiPack({
      api: ctx.api,
      database: ctx.db,
      ownerUserId: ctx.from.id,
      recreate: false,
    });
    await ctx.reply(formatPackSyncResult("synced", result), htmlReplyOptions);
  } catch (error) {
    await replyIntegrationError(ctx, error);
  }
});

tickersComposer.command("removepack", async (ctx) => {
  if (!ctx.dbEntities.user || !ctx.from) {
    await ctx.text("start");
    return;
  }

  try {
    const result = await removeTickerEmojiPack({
      api: ctx.api,
      database: ctx.db,
      ownerUserId: ctx.from.id,
    });
    await ctx.reply(
      `Emoji pack removed: ${escapeHtml(result.packName)}`,
      htmlReplyOptions,
    );
  } catch (error) {
    await replyIntegrationError(ctx, error);
  }
});

tickersComposer.command("stocks", async (ctx) => {
  if (!ctx.dbEntities.user || !ctx.from) {
    await ctx.text("start");
    return;
  }

  const {
    tickerDecorations,
    tickerLabelPreferences,
    tickerLabelLinks,
    tickerEmojiMappings,
  } = await readTickerDisplayPreferences(ctx.from.id);

  if (!hasUserIntegrations(ctx.db, ctx.dbEntities.user.userId)) {
    await ctx.text("no_integrations");
    return;
  }

  try {
    const positions = await fetchIntegratedPortfolio(
      ctx.db,
      ctx.dbEntities.user.userId,
    );
    const priceList = await buildIntegratedTickerList({
      positions: positions.filter(isStockPosition),
      tickerDecorations,
      tickerLabelPreferences,
      tickerLabelLinks,
      tickerEmojiMappings,
    });

    if (priceList.length === 0) {
      await ctx.text("no_positions");
      return;
    }

    await ctx.reply(priceList, htmlReplyOptions);
  } catch (error) {
    await replyIntegrationError(ctx, error);
  }
});

tickersComposer.command("options", async (ctx) => {
  if (!ctx.dbEntities.user || !ctx.from) {
    await ctx.text("start");
    return;
  }

  const preferences = await readTickerDisplayPreferences(ctx.from.id);
  const {
    tickerDecorations,
    tickerLabelPreferences,
    tickerLabelLinks,
    tickerEmojiMappings,
  } = preferences;
  const formatTicker = createTickerFormatter({
    tickerDecorations,
    tickerLabelPreferences,
    tickerLabelLinks,
    tickerEmojiMappings,
  });

  if (!hasUserIntegrations(ctx.db, ctx.dbEntities.user.userId)) {
    await ctx.text("no_integrations");
    return;
  }

  try {
    const positions = await fetchIntegratedPortfolio(
      ctx.db,
      ctx.dbEntities.user.userId,
    );
    const priceList = await buildIntegratedTickerList({
      positions: positions.filter(isOptionPosition),
      tickerDecorations,
      tickerLabelPreferences,
      tickerLabelLinks,
      tickerEmojiMappings,
      formatTicker,
    });

    if (priceList.length === 0) {
      await ctx.text("no_positions");
      return;
    }

    await ctx.reply(priceList, htmlReplyOptions);
  } catch (error) {
    await replyIntegrationError(ctx, error);
  }
});

tickersComposer.command("dump_options", async (ctx) => {
  if (!ctx.dbEntities.user) {
    await ctx.text("start");
    return;
  }

  if (!hasUserIntegrations(ctx.db, ctx.dbEntities.user.userId)) {
    await ctx.text("no_integrations");
    return;
  }

  try {
    const positions = await fetchIntegratedPortfolio(
      ctx.db,
      ctx.dbEntities.user.userId,
    );
    await replyJsonDump(
      ctx,
      positions.filter(isOptionPosition).map(toDumpablePosition),
    );
  } catch (error) {
    await replyIntegrationError(ctx, error);
  }
});

tickersComposer.command("dump_tickers", async (ctx) => {
  if (!ctx.dbEntities.user) {
    await ctx.text("start");
    return;
  }

  if (!hasUserIntegrations(ctx.db, ctx.dbEntities.user.userId)) {
    await ctx.text("no_integrations");
    return;
  }

  try {
    const positions = await fetchIntegratedPortfolio(
      ctx.db,
      ctx.dbEntities.user.userId,
    );
    await replyJsonDump(
      ctx,
      positions.filter(isStockPosition).map(toDumpablePosition),
    );
  } catch (error) {
    await replyIntegrationError(ctx, error);
  }
});

tickersComposer.command("perf", async (ctx) => {
  if (!ctx.dbEntities.user || !ctx.from) {
    await ctx.text("start");
    return;
  }

  const preferences = await readTickerDisplayPreferences(ctx.from.id);
  const {
    tickerDecorations,
    tickerLabelPreferences,
    tickerLabelLinks,
    tickerEmojiMappings,
  } = preferences;
  const formatTicker = createTickerFormatter({
    tickerDecorations,
    tickerLabelPreferences,
    tickerLabelLinks,
    tickerEmojiMappings,
  });

  if (!hasUserIntegrations(ctx.db, ctx.dbEntities.user.userId)) {
    await ctx.text("no_integrations");
    return;
  }

  try {
    const positions = await fetchIntegratedPortfolio(
      ctx.db,
      ctx.dbEntities.user.userId,
    );
    const performanceList = await buildIntegratedPerformanceList({
      positions,
      tickerDecorations,
      tickerLabelPreferences,
      tickerLabelLinks,
      tickerEmojiMappings,
      formatTicker,
    });

    if (performanceList.length === 0) {
      await ctx.text("no_positions");
      return;
    }

    await ctx.reply(performanceList, htmlReplyOptions);
  } catch (error) {
    await replyIntegrationError(ctx, error);
  }
});

tickersComposer.command("dpnl", async (ctx) => {
  if (!ctx.dbEntities.user || !ctx.from) {
    await ctx.text("start");
    return;
  }

  const preferences = await readTickerDisplayPreferences(ctx.from.id);
  const {
    tickerDecorations,
    tickerLabelPreferences,
    tickerLabelLinks,
    tickerEmojiMappings,
  } = preferences;
  const formatTicker = createTickerFormatter({
    tickerDecorations,
    tickerLabelPreferences,
    tickerLabelLinks,
    tickerEmojiMappings,
  });

  if (!hasUserIntegrations(ctx.db, ctx.dbEntities.user.userId)) {
    await ctx.text("no_integrations");
    return;
  }

  try {
    const positions = await fetchIntegratedPortfolio(
      ctx.db,
      ctx.dbEntities.user.userId,
    );
    const performanceList = await buildIntegratedDailyPerformanceList({
      positions,
      tickerDecorations,
      tickerLabelPreferences,
      tickerLabelLinks,
      tickerEmojiMappings,
      formatTicker,
    });

    if (performanceList.length === 0) {
      await ctx.text("no_positions");
      return;
    }

    await ctx.reply(performanceList, htmlReplyOptions);
  } catch (error) {
    await replyIntegrationError(ctx, error);
  }
});

tickersComposer.command("history", async (ctx) => {
  if (!ctx.dbEntities.user || !ctx.from) {
    await ctx.text("start");
    return;
  }

  const {
    tickerDecorations,
    tickerLabelPreferences,
    tickerLabelLinks,
    tickerEmojiMappings,
  } = await readTickerDisplayPreferences(ctx.from.id);

  if (!hasUserIntegrations(ctx.db, ctx.dbEntities.user.userId)) {
    await ctx.text("no_integrations");
    return;
  }

  try {
    const orders = await fetchIntegratedOrderHistory(
      ctx.db,
      ctx.dbEntities.user.userId,
    );
    const history = buildIntegratedHistory({
      orders,
      tickerDecorations,
      tickerLabelPreferences,
      tickerLabelLinks,
      tickerEmojiMappings,
    });

    if (history.length === 0) {
      await ctx.text("no_positions");
      return;
    }

    await ctx.reply(history, htmlReplyOptions);
  } catch (error) {
    await replyIntegrationError(ctx, error);
  }
});

tickersComposer.command("when", async (ctx) => {
  if (!ctx.dbEntities.user || !ctx.from) {
    await ctx.text("start");
    return;
  }

  if (!ctx.match) {
    await ctx.text("when");
    return;
  }

  const priceOverrides = parsePriceOverrides(ctx.match);
  if (!priceOverrides) {
    await ctx.text("when");
    return;
  }

  const preferences = await readTickerDisplayPreferences(ctx.from.id);
  const {
    tickerDecorations,
    tickerLabelPreferences,
    tickerLabelLinks,
    tickerEmojiMappings,
  } = preferences;
  const formatTicker = createTickerFormatter({
    tickerDecorations,
    tickerLabelPreferences,
    tickerLabelLinks,
    tickerEmojiMappings,
  });

  if (!hasUserIntegrations(ctx.db, ctx.dbEntities.user.userId)) {
    await ctx.text("no_integrations");
    return;
  }

  try {
    const positions = await fetchIntegratedPortfolio(
      ctx.db,
      ctx.dbEntities.user.userId,
    );
    const priceList = await buildIntegratedTickerList({
      positions,
      priceOverrides,
      tickerDecorations,
      tickerLabelPreferences,
      tickerLabelLinks,
      tickerEmojiMappings,
      formatTicker,
    });

    if (priceList.length === 0) {
      await ctx.text("no_positions");
      return;
    }

    await ctx.reply(priceList, htmlReplyOptions);
  } catch (error) {
    await replyIntegrationError(ctx, error);
  }
});
