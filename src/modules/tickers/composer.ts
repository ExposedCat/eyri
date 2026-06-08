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
  readTickerLabelLinks,
  readTickerLabelPreferences,
  setTickerDecoration,
  setTickerLabelLink,
  setTickerLabelPreference,
} from "./decorations.ts";
import {
  buildIntegratedHistory,
  buildIntegratedPerformanceList,
  buildIntegratedTickerList,
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

async function readTickerDisplayPreferences(userId: number) {
  const [tickerDecorations, tickerLabelPreferences, tickerLabelLinks] =
    await Promise.all([
      readTickerDecorations(userId),
      readTickerLabelPreferences(userId),
      readTickerLabelLinks(userId),
    ]);

  return {
    tickerDecorations,
    tickerLabelPreferences,
    tickerLabelLinks,
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
        const accountId = typeof integration.credentials.accountId === "string"
          ? `, account ${escapeHtml(integration.credentials.accountId)}`
          : "";
        return `${integration.id}. IBKR ${escapeHtml(instanceUrl)}${accountId}`;
      }

      return `${integration.id}. ${escapeHtml(integration.kind)}`;
    })
    .join("\n");
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

tickersComposer.command("integration_delete", async (ctx) => {
  if (!ctx.dbEntities.user) {
    await ctx.text("start");
    return;
  }

  const kind = ctx.match?.trim() as IntegrationKind | undefined;
  if (kind !== "ibkr") {
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
    `${formatTickerDecorations(parsed.decorations)} ${
      escapeHtml(
        parsed.ticker,
      )
    } decorated (${parsed.decorations.length}).`,
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
  const labelStatus = parsed.label === false
    ? "hidden"
    : `set to ${escapeHtml(parsed.label)}`;
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
  const linkStatus = parsed.tag === false
    ? "removed"
    : `set to ${escapeHtml(parsed.tag)}`;
  await ctx.reply(
    `${escapeHtml(parsed.ticker)} link ${linkStatus}.`,
    htmlReplyOptions,
  );
});

tickersComposer.command("tickers", async (ctx) => {
  if (!ctx.dbEntities.user || !ctx.from) {
    await ctx.text("start");
    return;
  }

  const { tickerDecorations, tickerLabelPreferences, tickerLabelLinks } =
    await readTickerDisplayPreferences(ctx.from.id);

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
      tickerDecorations,
      tickerLabelPreferences,
      tickerLabelLinks,
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

tickersComposer.command("perf", async (ctx) => {
  if (!ctx.dbEntities.user || !ctx.from) {
    await ctx.text("start");
    return;
  }

  const { tickerDecorations, tickerLabelPreferences, tickerLabelLinks } =
    await readTickerDisplayPreferences(ctx.from.id);

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

  const { tickerDecorations, tickerLabelPreferences, tickerLabelLinks } =
    await readTickerDisplayPreferences(ctx.from.id);

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

  const { tickerDecorations, tickerLabelPreferences, tickerLabelLinks } =
    await readTickerDisplayPreferences(ctx.from.id);

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
