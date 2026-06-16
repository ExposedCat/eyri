import { InputFile, type Api } from "grammy";
import type { Database } from "../database/setup.ts";
import { getAllIntegrations } from "../database/integration.ts";
import { fetchIntegrationPortfolio } from "../integrations/service.ts";

type TickerEmojiPackRow = {
  owner_user_id: string;
  pack_name: string;
  pack_title: string;
};

type TickerEmojiMappingRow = {
  ticker: string;
  custom_emoji_id: string;
};

type PortfolioTickerIcon = {
  ticker: string;
  iconTicker: string;
  aliases: string[];
};

type SyncEmojiPackArgs = {
  api: Api;
  database: Database;
  ownerUserId: number;
  recreate: boolean;
};

type SyncEmojiPackResult = {
  packName: string;
  totalTickers: number;
  added: string[];
  skipped: string[];
  errors: string[];
};

type RemoveEmojiPackArgs = {
  api: Api;
  database: Database;
  ownerUserId: number;
};

const STICKER_SET_LIMIT = 200;
const DEFAULT_EMOJI_TEXT = "💰";

function ensureSchema(database: Database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS ticker_emoji_packs (
      owner_user_id TEXT PRIMARY KEY,
      pack_name TEXT NOT NULL,
      pack_title TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS ticker_emoji_mappings (
      ticker TEXT PRIMARY KEY,
      pack_name TEXT NOT NULL,
      custom_emoji_id TEXT NOT NULL,
      emoji_text TEXT NOT NULL DEFAULT '${DEFAULT_EMOJI_TEXT}',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
}

function normalizeTicker(ticker: string) {
  return ticker.trim().toUpperCase();
}

function getPackTitle(ownerUserId: number) {
  return `Eyri Tickers ${ownerUserId}`;
}

function getPackName(ownerUserId: number, botUsername: string, unique = false) {
  const suffix = unique ? `_${Date.now().toString(36)}` : "";
  return `eyri_${ownerUserId}${suffix}_by_${botUsername}`;
}

type IconSource = {
  name: string;
  url: string;
};

function getElbstreamIconUrl(ticker: string) {
  return `https://api.elbstream.com/logos/symbol/${encodeURIComponent(ticker)}?format=png&size=100`;
}

function getLogoDevIconUrl(ticker: string, token: string) {
  return `https://img.logo.dev/ticker/${encodeURIComponent(ticker)}?size=100&format=png&token=${encodeURIComponent(token)}`;
}

function getIconSources(ticker: string): IconSource[] {
  const sources = [
    {
      name: "elbstream",
      url: getElbstreamIconUrl(ticker),
    },
  ];
  const logoDevToken = Deno.env.get("ICON_TOKEN");
  if (logoDevToken) {
    sources.push({
      name: "logo.dev",
      url: getLogoDevIconUrl(ticker, logoDevToken),
    });
  }

  return sources;
}

function parseOptionUnderlying(ticker: string) {
  const match = ticker
    .trim()
    .toUpperCase()
    .match(/^\+(.+?)\./);
  return match?.[1] ?? null;
}

function stripMarketSuffix(ticker: string) {
  return ticker.replace(/\.[A-Z]{2}$/, "");
}

function getTickerAliases(ticker: string, iconTicker: string) {
  return [
    ...new Set([ticker, iconTicker].filter(Boolean).map(normalizeTicker)),
  ];
}

function toPortfolioTickerIcon(ticker: string): PortfolioTickerIcon {
  const underlying = parseOptionUnderlying(ticker);
  if (underlying) {
    const normalizedUnderlying = normalizeTicker(underlying);
    const iconTicker = stripMarketSuffix(normalizedUnderlying);
    return {
      ticker: iconTicker,
      iconTicker,
      aliases: getTickerAliases(normalizedUnderlying, iconTicker),
    };
  }

  const normalizedTicker = normalizeTicker(ticker);
  const iconTicker = stripMarketSuffix(normalizedTicker);
  return {
    ticker: iconTicker,
    iconTicker,
    aliases: getTickerAliases(normalizedTicker, iconTicker),
  };
}

async function collectAllPortfolioTickers(
  database: Database,
): Promise<{ tickers: PortfolioTickerIcon[]; errors: string[] }> {
  const tickers = new Map<string, PortfolioTickerIcon>();
  const errors: string[] = [];

  for (const integration of getAllIntegrations(database)) {
    try {
      const positions = await fetchIntegrationPortfolio(database, integration);
      for (const position of positions) {
        const ticker = toPortfolioTickerIcon(position.ticker);
        if (ticker.ticker) {
          const existingTicker = tickers.get(ticker.ticker);
          if (existingTicker) {
            existingTicker.aliases = [
              ...new Set([...existingTicker.aliases, ...ticker.aliases]),
            ].sort();
          } else {
            tickers.set(ticker.ticker, ticker);
          }
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(`${integration.kind}#${integration.id}: ${message}`);
    }
  }

  return {
    tickers: [...tickers.values()].sort((tickerA, tickerB) =>
      tickerA.ticker.localeCompare(tickerB.ticker),
    ),
    errors,
  };
}

function readPack(database: Database, ownerUserId: number) {
  ensureSchema(database);
  return database
    .prepare(`
      SELECT owner_user_id, pack_name, pack_title
      FROM ticker_emoji_packs
      WHERE owner_user_id = ?
    `)
    .get(String(ownerUserId)) as TickerEmojiPackRow | undefined;
}

function upsertPack(
  database: Database,
  ownerUserId: number,
  packName: string,
  packTitle: string,
) {
  ensureSchema(database);
  database
    .prepare(`
      INSERT INTO ticker_emoji_packs (
        owner_user_id,
        pack_name,
        pack_title
      ) VALUES (?, ?, ?)
      ON CONFLICT(owner_user_id) DO UPDATE SET
        pack_name = excluded.pack_name,
        pack_title = excluded.pack_title,
        updated_at = CURRENT_TIMESTAMP
    `)
    .run(String(ownerUserId), packName, packTitle);
}

function readMappedTickers(database: Database, packName: string) {
  ensureSchema(database);
  const rows = database
    .prepare(`
      SELECT ticker, custom_emoji_id
      FROM ticker_emoji_mappings
      WHERE pack_name = ?
    `)
    .all(packName) as TickerEmojiMappingRow[];

  return new Map(
    rows.map((row) => [normalizeTicker(row.ticker), row.custom_emoji_id]),
  );
}

function upsertTickerEmojiMapping(
  database: Database,
  packName: string,
  ticker: string,
  customEmojiId: string,
) {
  ensureSchema(database);
  database
    .prepare(`
      INSERT INTO ticker_emoji_mappings (
        ticker,
        pack_name,
        custom_emoji_id,
        emoji_text
      ) VALUES (?, ?, ?, ?)
      ON CONFLICT(ticker) DO UPDATE SET
        pack_name = excluded.pack_name,
        custom_emoji_id = excluded.custom_emoji_id,
        emoji_text = excluded.emoji_text,
        updated_at = CURRENT_TIMESTAMP
    `)
    .run(normalizeTicker(ticker), packName, customEmojiId, DEFAULT_EMOJI_TEXT);
}

function deletePackData(
  database: Database,
  packName: string,
  ownerUserId: number,
) {
  ensureSchema(database);
  database.exec("BEGIN");
  try {
    database
      .prepare(`
        DELETE FROM ticker_emoji_mappings
        WHERE pack_name = ?
      `)
      .run(packName);
    database
      .prepare(`
        DELETE FROM ticker_emoji_packs
        WHERE owner_user_id = ?
      `)
      .run(String(ownerUserId));
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

async function readLastCustomEmojiId(api: Api, packName: string) {
  const stickerSet = await api.getStickerSet(packName);
  return stickerSet.stickers.at(-1)?.custom_emoji_id ?? null;
}

async function uploadTickerIcon({
  api,
  ownerUserId,
  ticker,
  iconTicker,
}: {
  api: Api;
  ownerUserId: number;
  ticker: string;
  iconTicker: string;
}) {
  const errors: string[] = [];
  for (const source of getIconSources(iconTicker)) {
    try {
      const response = await fetch(source.url);
      if (!response.ok) {
        throw new Error(`${response.status} ${response.statusText}`);
      }

      const iconBytes = new Uint8Array(await response.arrayBuffer());
      const uploaded = await api.uploadStickerFile(
        ownerUserId,
        "static",
        new InputFile(iconBytes, `${ticker}.png`),
      );
      return uploaded.file_id;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(`${source.name}: ${message}`);
    }
  }

  if (!Deno.env.get("ICON_TOKEN")) {
    errors.push("logo.dev: ICON_TOKEN is missing");
  }

  throw new Error(
    `Failed to fetch/upload icon for ${ticker}: ${errors.join("; ")}`,
  );
}

async function addTickerToEmojiPack({
  api,
  ownerUserId,
  packName,
  ticker,
  iconTicker,
  create,
}: {
  api: Api;
  ownerUserId: number;
  packName: string;
  ticker: string;
  iconTicker: string;
  create: boolean;
}) {
  const stickerFileId = await uploadTickerIcon({
    api,
    ownerUserId,
    ticker,
    iconTicker,
  });
  const sticker = {
    sticker: stickerFileId,
    format: "static" as const,
    emoji_list: [DEFAULT_EMOJI_TEXT],
    keywords: [ticker],
  };

  if (create) {
    await api.createNewStickerSet(
      ownerUserId,
      packName,
      getPackTitle(ownerUserId),
      [sticker],
      {
        sticker_type: "custom_emoji",
      },
    );
  } else {
    await api.addStickerToSet(ownerUserId, packName, sticker);
  }

  const customEmojiId = await readLastCustomEmojiId(api, packName);
  if (!customEmojiId) {
    throw new Error(`Telegram did not return a custom emoji id for ${ticker}`);
  }

  return customEmojiId;
}

export async function syncTickerEmojiPack({
  api,
  database,
  ownerUserId,
  recreate,
}: SyncEmojiPackArgs): Promise<SyncEmojiPackResult> {
  const bot = await api.getMe();
  if (!bot.username) {
    throw new Error("Bot username is required to create a sticker set");
  }

  const existingPack = readPack(database, ownerUserId);
  const packName = recreate
    ? getPackName(ownerUserId, bot.username, true)
    : (existingPack?.pack_name ?? getPackName(ownerUserId, bot.username));
  const packTitle = getPackTitle(ownerUserId);
  const { tickers, errors } = await collectAllPortfolioTickers(database);

  if (tickers.length === 0) {
    throw new Error("No tickers were returned by configured integrations");
  }

  if (tickers.length > STICKER_SET_LIMIT) {
    throw new Error(
      `Telegram custom emoji packs can contain at most ${STICKER_SET_LIMIT} stickers; found ${tickers.length} tickers`,
    );
  }

  if (!recreate && !existingPack) {
    throw new Error("No emoji pack is configured yet. Use /createpack first.");
  }

  const mappedTickers = recreate
    ? new Map<string, string>()
    : readMappedTickers(database, packName);
  const added: string[] = [];
  const skipped: string[] = [];
  let hasStickerSet = !recreate;

  for (const { ticker, iconTicker, aliases } of tickers) {
    const existingCustomEmojiId =
      aliases.map((alias) => mappedTickers.get(alias)).find(Boolean) ?? null;
    if (existingCustomEmojiId) {
      for (const alias of aliases) {
        if (!mappedTickers.has(alias)) {
          upsertTickerEmojiMapping(
            database,
            packName,
            alias,
            existingCustomEmojiId,
          );
        }
      }
      skipped.push(ticker);
      continue;
    }

    try {
      const customEmojiId = await addTickerToEmojiPack({
        api,
        ownerUserId,
        packName,
        ticker,
        iconTicker,
        create: !hasStickerSet,
      });
      hasStickerSet = true;
      for (const alias of aliases) {
        upsertTickerEmojiMapping(database, packName, alias, customEmojiId);
      }
      added.push(ticker);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(`${ticker}: ${message}`);
    }
  }

  if (!hasStickerSet) {
    throw new Error(
      `Failed to create emoji pack:\n${errors.slice(0, 10).join("\n")}`,
    );
  }

  upsertPack(database, ownerUserId, packName, packTitle);

  return {
    packName,
    totalTickers: tickers.length,
    added,
    skipped,
    errors,
  };
}

export async function removeTickerEmojiPack({
  api,
  database,
  ownerUserId,
}: RemoveEmojiPackArgs) {
  const existingPack = readPack(database, ownerUserId);
  if (!existingPack) {
    throw new Error("No emoji pack is configured.");
  }

  await api.deleteStickerSet(existingPack.pack_name);
  deletePackData(database, existingPack.pack_name, ownerUserId);

  return {
    packName: existingPack.pack_name,
  };
}
