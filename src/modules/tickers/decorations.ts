import type { Database } from "@db/sqlite";
import type { CustomContext } from "../bot/types.ts";
import { getDatabase } from "../storage/sqlite.ts";

export type TickerDecoration = {
  tgEmoji: string;
  text: string;
  isCustomEmoji: boolean;
};

export type TickerDecorations = Record<string, TickerDecoration[]>;
export type TickerLabelPreferences = Record<string, string | false>;
export type TickerLabelLinks = Record<string, string>;
export type TickerEmojiMappings = Record<string, TickerDecoration>;

type TickerDecorationRow = {
  ticker: string;
  emoji_index: number;
  tg_emoji: string;
  emoji_text: string;
  is_custom_emoji: number;
};

type TickerLabelPreferenceRow = {
  ticker: string;
  label: string;
};

type TickerLabelLinkRow = {
  ticker: string;
  tag: string;
};

type TickerEmojiMappingRow = {
  ticker: string;
  custom_emoji_id: string;
  emoji_text: string;
};

type TableColumn = {
  name: string;
  pk: number;
};

function normalizeTicker(ticker: string) {
  return ticker.trim().toUpperCase();
}

function splitGraphemes(text: string) {
  if ("Segmenter" in Intl) {
    return Array.from(
      new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text),
      (segment) => segment.segment,
    );
  }

  return [...text];
}

function tableExists(db: Database, tableName: string) {
  const row = db
    .prepare(`
      SELECT name
      FROM sqlite_master
      WHERE type = 'table' AND name = ?
    `)
    .get(tableName);
  return Boolean(row);
}

function getTableColumns(db: Database, tableName: string) {
  return db.prepare(`PRAGMA table_info(${tableName})`).all() as TableColumn[];
}

function hasColumn(columns: TableColumn[], columnName: string) {
  return columns.some((column) => column.name === columnName);
}

function hasExpectedSchema(db: Database) {
  const columns = getTableColumns(db, "ticker_decorations");
  const primaryKeyColumns = columns
    .filter((column) => column.pk > 0)
    .sort((columnA, columnB) => columnA.pk - columnB.pk)
    .map((column) => column.name);

  return (
    hasColumn(columns, "user_id") &&
    hasColumn(columns, "ticker") &&
    hasColumn(columns, "emoji_index") &&
    hasColumn(columns, "tg_emoji") &&
    hasColumn(columns, "emoji_text") &&
    hasColumn(columns, "is_custom_emoji") &&
    primaryKeyColumns.join(",") === "user_id,ticker,emoji_index"
  );
}

function createTickerDecorationsTable(db: Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ticker_decorations (
      user_id TEXT NOT NULL,
      ticker TEXT NOT NULL,
      emoji_index INTEGER NOT NULL,
      tg_emoji TEXT NOT NULL,
      emoji_text TEXT NOT NULL,
      is_custom_emoji INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (user_id, ticker, emoji_index)
    )
  `);
}

function createTickerLabelPreferencesTable(db: Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ticker_label_preferences (
      user_id TEXT NOT NULL,
      ticker TEXT NOT NULL,
      label TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (user_id, ticker)
    )
  `);
}

function createTickerLabelLinksTable(db: Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ticker_label_links (
      user_id TEXT NOT NULL,
      ticker TEXT NOT NULL,
      tag TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (user_id, ticker)
    )
  `);
}

function createTickerEmojiPacksTable(db: Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ticker_emoji_packs (
      owner_user_id TEXT PRIMARY KEY,
      pack_name TEXT NOT NULL,
      pack_title TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
}

function createTickerEmojiMappingsTable(db: Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ticker_emoji_mappings (
      ticker TEXT PRIMARY KEY,
      pack_name TEXT NOT NULL,
      custom_emoji_id TEXT NOT NULL,
      emoji_text TEXT NOT NULL DEFAULT '💰',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
}

function hasExpectedTickerLabelPreferencesSchema(db: Database) {
  const columns = getTableColumns(db, "ticker_label_preferences");
  const primaryKeyColumns = columns
    .filter((column) => column.pk > 0)
    .sort((columnA, columnB) => columnA.pk - columnB.pk)
    .map((column) => column.name);

  return (
    hasColumn(columns, "user_id") &&
    hasColumn(columns, "ticker") &&
    hasColumn(columns, "label") &&
    primaryKeyColumns.join(",") === "user_id,ticker"
  );
}

function hasExpectedTickerLabelLinksSchema(db: Database) {
  const columns = getTableColumns(db, "ticker_label_links");
  const primaryKeyColumns = columns
    .filter((column) => column.pk > 0)
    .sort((columnA, columnB) => columnA.pk - columnB.pk)
    .map((column) => column.name);

  return (
    hasColumn(columns, "user_id") &&
    hasColumn(columns, "ticker") &&
    hasColumn(columns, "tag") &&
    hasColumn(columns, "created_at") &&
    hasColumn(columns, "updated_at") &&
    primaryKeyColumns.join(",") === "user_id,ticker"
  );
}

function migrateTickerLabelPreferencesTable(db: Database) {
  const columns = getTableColumns(db, "ticker_label_preferences");
  const hasLabel = hasColumn(columns, "label");
  const hasShowLabel = hasColumn(columns, "show_label");

  db.exec(`
    ALTER TABLE ticker_label_preferences RENAME TO ticker_label_preferences_old;
  `);
  createTickerLabelPreferencesTable(db);

  if (hasLabel) {
    db.exec(`
      INSERT INTO ticker_label_preferences (
        user_id,
        ticker,
        label,
        created_at,
        updated_at
      )
      SELECT
        user_id,
        ticker,
        label,
        created_at,
        updated_at
      FROM ticker_label_preferences_old;

      DROP TABLE ticker_label_preferences_old;
    `);
    return;
  }

  if (hasShowLabel) {
    db.exec(`
      INSERT INTO ticker_label_preferences (
        user_id,
        ticker,
        label,
        created_at,
        updated_at
      )
      SELECT
        user_id,
        ticker,
        CASE
          WHEN show_label = 0 THEN 'false'
          WHEN show_label = 1 THEN ticker
          ELSE CAST(show_label AS TEXT)
        END,
        created_at,
        updated_at
      FROM ticker_label_preferences_old;

      DROP TABLE ticker_label_preferences_old;
    `);
    return;
  }

  db.exec("DROP TABLE ticker_label_preferences_old;");
}

function migrateTickerLabelLinksTable(db: Database) {
  const columns = getTableColumns(db, "ticker_label_links");
  const hasTag = hasColumn(columns, "tag");
  const hasCreatedAt = hasColumn(columns, "created_at");
  const hasUpdatedAt = hasColumn(columns, "updated_at");

  db.exec(`
    ALTER TABLE ticker_label_links RENAME TO ticker_label_links_old;
  `);
  createTickerLabelLinksTable(db);

  if (hasTag) {
    db.exec(`
      INSERT INTO ticker_label_links (
        user_id,
        ticker,
        tag,
        created_at,
        updated_at
      )
      SELECT
        user_id,
        ticker,
        tag,
        ${hasCreatedAt ? "created_at" : "CURRENT_TIMESTAMP"},
        ${hasUpdatedAt ? "updated_at" : "CURRENT_TIMESTAMP"}
      FROM ticker_label_links_old;

      DROP TABLE ticker_label_links_old;
    `);
    return;
  }

  db.exec("DROP TABLE ticker_label_links_old;");
}

function migrateTickerDecorationsTable(db: Database) {
  const columns = getTableColumns(db, "ticker_decorations");
  const hasEmojiIndex = hasColumn(columns, "emoji_index");

  db.exec(`
    ALTER TABLE ticker_decorations RENAME TO ticker_decorations_old;
  `);
  createTickerDecorationsTable(db);
  db.exec(`
    INSERT INTO ticker_decorations (
      user_id,
      ticker,
      emoji_index,
      tg_emoji,
      emoji_text,
      is_custom_emoji,
      created_at,
      updated_at
    )
    SELECT
      user_id,
      ticker,
      ${hasEmojiIndex ? "emoji_index" : "0"},
      tg_emoji,
      emoji_text,
      is_custom_emoji,
      created_at,
      updated_at
    FROM ticker_decorations_old;

    DROP TABLE ticker_decorations_old;
  `);
}

function ensureSchema(db: Database) {
  if (!tableExists(db, "ticker_decorations")) {
    createTickerDecorationsTable(db);
  } else if (!hasExpectedSchema(db)) {
    migrateTickerDecorationsTable(db);
  }

  if (!tableExists(db, "ticker_label_preferences")) {
    createTickerLabelPreferencesTable(db);
  } else if (!hasExpectedTickerLabelPreferencesSchema(db)) {
    migrateTickerLabelPreferencesTable(db);
  }

  if (!tableExists(db, "ticker_label_links")) {
    createTickerLabelLinksTable(db);
  } else if (!hasExpectedTickerLabelLinksSchema(db)) {
    migrateTickerLabelLinksTable(db);
  }

  if (!tableExists(db, "ticker_emoji_packs")) {
    createTickerEmojiPacksTable(db);
  }

  if (!tableExists(db, "ticker_emoji_mappings")) {
    createTickerEmojiMappingsTable(db);
  }
}

export async function readTickerDecorations(
  userId: string | number,
): Promise<TickerDecorations> {
  const db = await getDatabase();
  ensureSchema(db);
  const rows = db
    .prepare(`
      SELECT ticker, emoji_index, tg_emoji, emoji_text, is_custom_emoji
      FROM ticker_decorations
      WHERE user_id = ?
      ORDER BY ticker, emoji_index
    `)
    .all(String(userId)) as TickerDecorationRow[];

  const decorations: TickerDecorations = {};
  for (const row of rows) {
    const ticker = normalizeTicker(row.ticker);
    decorations[ticker] ??= [];
    decorations[ticker].push({
      tgEmoji: row.tg_emoji,
      text: row.emoji_text,
      isCustomEmoji: row.is_custom_emoji === 1,
    });
  }
  return decorations;
}

export async function setTickerDecoration(
  userId: string | number,
  ticker: string,
  decorations: TickerDecoration[],
) {
  const db = await getDatabase();
  ensureSchema(db);
  const normalizedUserId = String(userId);
  const normalizedTicker = normalizeTicker(ticker);

  db.exec("BEGIN");
  try {
    db.prepare(`
      DELETE FROM ticker_decorations
      WHERE user_id = ? AND ticker = ?
    `).run(normalizedUserId, normalizedTicker);

    const insertDecoration = db.prepare(`
      INSERT INTO ticker_decorations (
        user_id,
        ticker,
        emoji_index,
        tg_emoji,
        emoji_text,
        is_custom_emoji
      ) VALUES (?, ?, ?, ?, ?, ?)
    `);
    decorations.forEach((decoration, index) => {
      insertDecoration.run(
        normalizedUserId,
        normalizedTicker,
        index,
        decoration.tgEmoji,
        decoration.text,
        decoration.isCustomEmoji ? 1 : 0,
      );
    });

    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export async function readTickerLabelPreferences(
  userId: string | number,
): Promise<TickerLabelPreferences> {
  const db = await getDatabase();
  ensureSchema(db);
  const rows = db
    .prepare(`
      SELECT ticker, label
      FROM ticker_label_preferences
      WHERE user_id = ?
    `)
    .all(String(userId)) as TickerLabelPreferenceRow[];

  return Object.fromEntries(
    rows.map((row) => [
      normalizeTicker(row.ticker),
      row.label === "false" ? false : row.label,
    ]),
  );
}

export async function setTickerLabelPreference(
  userId: string | number,
  ticker: string,
  label: string | false,
) {
  const db = await getDatabase();
  ensureSchema(db);
  db.prepare(`
    INSERT INTO ticker_label_preferences (
      user_id,
      ticker,
      label
    ) VALUES (?, ?, ?)
    ON CONFLICT(user_id, ticker) DO UPDATE SET
      label = excluded.label,
      updated_at = CURRENT_TIMESTAMP
  `).run(
    String(userId),
    normalizeTicker(ticker),
    label === false ? "false" : label,
  );
}

export async function readTickerLabelLinks(
  userId: string | number,
): Promise<TickerLabelLinks> {
  const db = await getDatabase();
  ensureSchema(db);
  const rows = db
    .prepare(`
      SELECT ticker, tag
      FROM ticker_label_links
      WHERE user_id = ?
    `)
    .all(String(userId)) as TickerLabelLinkRow[];

  return Object.fromEntries(
    rows.map((row) => [normalizeTicker(row.ticker), row.tag]),
  );
}

export async function readTickerEmojiMappings(): Promise<TickerEmojiMappings> {
  const db = await getDatabase();
  ensureSchema(db);
  const rows = db
    .prepare(`
      SELECT ticker, custom_emoji_id, emoji_text
      FROM ticker_emoji_mappings
    `)
    .all() as TickerEmojiMappingRow[];

  return Object.fromEntries(
    rows.map((row) => [
      normalizeTicker(row.ticker),
      {
        tgEmoji: row.custom_emoji_id,
        text: row.emoji_text,
        isCustomEmoji: true,
      },
    ]),
  );
}

export async function setTickerLabelLink(
  userId: string | number,
  ticker: string,
  tag: string | false,
) {
  const db = await getDatabase();
  ensureSchema(db);
  const normalizedUserId = String(userId);
  const normalizedTicker = normalizeTicker(ticker);

  if (tag === false) {
    db.prepare(`
      DELETE FROM ticker_label_links
      WHERE user_id = ? AND ticker = ?
    `).run(normalizedUserId, normalizedTicker);
    return;
  }

  db.prepare(`
    INSERT INTO ticker_label_links (
      user_id,
      ticker,
      tag
    ) VALUES (?, ?, ?)
    ON CONFLICT(user_id, ticker) DO UPDATE SET
      tag = excluded.tag,
      updated_at = CURRENT_TIMESTAMP
  `).run(normalizedUserId, normalizedTicker, tag);
}

export function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function escapeHtmlAttribute(value: string) {
  return escapeHtml(value).replaceAll('"', "&quot;");
}

export function formatTickerDecoration(decoration: TickerDecoration) {
  if (decoration.isCustomEmoji) {
    return `<tg-emoji emoji-id="${escapeHtmlAttribute(
      decoration.tgEmoji,
    )}">${escapeHtml(decoration.text)}</tg-emoji>`;
  }

  return escapeHtml(decoration.text);
}

export function formatTickerDecorations(decorations: TickerDecoration[]) {
  return decorations.map(formatTickerDecoration).join("");
}

function formatTickerLabel(label: string, linkTag?: string) {
  const formattedLabel = escapeHtml(label);
  if (!linkTag) {
    return formattedLabel;
  }

  return `<a href="${escapeHtmlAttribute(
    `https://www.google.com/finance/beta/quote/${linkTag}`,
  )}">${formattedLabel}</a>`;
}

export function formatDecoratedTicker(
  ticker: string,
  decorations?: TickerDecorations,
  labelPreferences?: TickerLabelPreferences,
  labelLinks?: TickerLabelLinks,
  emojiMappings?: TickerEmojiMappings,
) {
  const normalizedTicker = normalizeTicker(ticker);
  const labelPreference = labelPreferences?.[normalizedTicker];
  const label = labelPreference === false ? null : (labelPreference ?? ticker);
  const linkTag = label === null ? undefined : labelLinks?.[normalizedTicker];
  const tickerDecorations = decorations?.[normalizedTicker];
  const decorated =
    tickerDecorations && tickerDecorations.length > 0
      ? formatTickerDecorations(tickerDecorations)
      : emojiMappings?.[normalizedTicker]
        ? formatTickerDecoration(emojiMappings[normalizedTicker])
        : null;
  if (!decorated) {
    return label === null ? "" : formatTickerLabel(label, linkTag);
  }

  return label === null
    ? decorated
    : `${decorated} ${formatTickerLabel(label, linkTag)}`;
}

export function parseDecorateCommand(ctx: CustomContext): {
  ticker: string;
  decorations: TickerDecoration[];
} | null {
  const text = ctx.message?.text;
  if (!text) {
    return null;
  }

  const entities = ctx.message.entities ?? [];
  const commandEntity = entities.find(
    (entity) => entity.type === "bot_command" && entity.offset === 0,
  );
  const fallbackCommand = text.match(/^\/decorate(?:@\w+)?/);
  const argsStart =
    commandEntity?.length ?? (fallbackCommand ? fallbackCommand[0].length : 0);
  if (argsStart === 0) {
    return null;
  }

  const leadingWhitespaceLength =
    text.slice(argsStart).match(/^\s*/)?.[0].length ?? 0;
  const argsBase = argsStart + leadingWhitespaceLength;
  const args = text.slice(argsBase);
  const tickerMatch = args.match(/^\S+/);
  if (!tickerMatch) {
    return null;
  }

  const ticker = normalizeTicker(tickerMatch[0]);
  const afterTicker = argsBase + tickerMatch[0].length;
  const decorationLeadingWhitespaceLength =
    text.slice(afterTicker).match(/^\s*/)?.[0].length ?? 0;
  const decorationStart = afterTicker + decorationLeadingWhitespaceLength;
  const decorationText = text.slice(decorationStart).trimEnd();
  if (!ticker || !decorationText) {
    return null;
  }

  const decorationEnd = decorationStart + decorationText.length;
  const customEmojiDecorations = entities
    .filter(
      (entity) =>
        entity.type === "custom_emoji" &&
        entity.offset >= decorationStart &&
        entity.offset < decorationEnd &&
        "custom_emoji_id" in entity &&
        typeof entity.custom_emoji_id === "string",
    )
    .sort((entityA, entityB) => entityA.offset - entityB.offset)
    .flatMap((entity) => {
      const entityText = text.slice(
        entity.offset,
        entity.offset + entity.length,
      );
      const customEmojiId =
        "custom_emoji_id" in entity &&
        typeof entity.custom_emoji_id === "string"
          ? entity.custom_emoji_id
          : "";

      return splitGraphemes(entityText).map((text) => ({
        tgEmoji: customEmojiId,
        text,
        isCustomEmoji: true,
      }));
    });

  if (customEmojiDecorations.length > 0) {
    return {
      ticker,
      decorations: customEmojiDecorations,
    };
  }

  return {
    ticker,
    decorations: decorationText.split(/\s+/).map((text) => ({
      tgEmoji: text,
      text,
      isCustomEmoji: false,
    })),
  };
}

export function parseLabelCommand(input: string): {
  ticker: string;
  label: string | false;
} | null {
  const trimmedInput = input.trim();
  const tickerMatch = trimmedInput.match(/^\S+/);
  if (!tickerMatch) {
    return null;
  }

  const ticker = tickerMatch[0];
  const label = trimmedInput.slice(ticker.length).trim();
  if (!label) {
    return null;
  }

  return {
    ticker: normalizeTicker(ticker),
    label: label === "false" ? false : label,
  };
}

export function parseLinkCommand(input: string): {
  ticker: string;
  tag: string | false;
} | null {
  const trimmedInput = input.trim();
  const tickerMatch = trimmedInput.match(/^\S+/);
  if (!tickerMatch) {
    return null;
  }

  const ticker = tickerMatch[0];
  const tag = trimmedInput.slice(ticker.length).trim();
  if (!tag) {
    return null;
  }

  return {
    ticker: normalizeTicker(ticker),
    tag: tag === "false" ? false : tag,
  };
}
