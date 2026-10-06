import type { ServiceResult } from "../../utils/service.ts";
import type { Database } from "./setup.ts";

export type IntegrationKind = "ibkr" | "f24";

export type Integration = {
  id: number;
  userId: number;
  kind: IntegrationKind;
  credentials: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
};

type IntegrationRow = {
  id: number;
  user_id: number;
  kind: string;
  credentials_json: string;
  created_at: string;
  updated_at: string;
};

function isIntegrationKind(value: string): value is IntegrationKind {
  return value === "ibkr" || value === "f24";
}

function parseCredentials(value: string) {
  const parsed = JSON.parse(value);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {};
  }

  return parsed as Record<string, unknown>;
}

function toIntegration(row: IntegrationRow): Integration | null {
  if (!isIntegrationKind(row.kind)) {
    return null;
  }

  return {
    id: row.id,
    userId: row.user_id,
    kind: row.kind,
    credentials: parseCredentials(row.credentials_json),
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  };
}

export function getUserIntegrations(database: Database, userId: number) {
  const rows = database
    .prepare(`
      SELECT id, user_id, kind, credentials_json, created_at, updated_at
      FROM integrations
      WHERE user_id = ?
      ORDER BY id
    `)
    .all(userId) as IntegrationRow[];

  return rows.flatMap((row) => {
    const integration = toIntegration(row);
    return integration ? [integration] : [];
  });
}

export function getAllIntegrations(database: Database) {
  const rows = database
    .prepare(`
      SELECT id, user_id, kind, credentials_json, created_at, updated_at
      FROM integrations
      ORDER BY user_id, id
    `)
    .all() as IntegrationRow[];

  return rows.flatMap((row) => {
    const integration = toIntegration(row);
    return integration ? [integration] : [];
  });
}

export function hasUserIntegrations(database: Database, userId: number) {
  const row = database
    .prepare(`
      SELECT 1
      FROM integrations
      WHERE user_id = ?
      LIMIT 1
    `)
    .get(userId);

  return Boolean(row);
}

type CreateIntegrationArgs = {
  database: Database;
  userId: number;
  kind: IntegrationKind;
  credentials: Record<string, unknown>;
};

export function createIntegration({
  database,
  userId,
  kind,
  credentials,
}: CreateIntegrationArgs): ServiceResult<Integration> {
  try {
    database
      .prepare(`
        INSERT INTO integrations (user_id, kind, credentials_json)
        VALUES (?, ?, ?)
      `)
      .run(userId, kind, JSON.stringify(credentials));

    const row = database.prepare(`
      SELECT id, user_id, kind, credentials_json, created_at, updated_at
      FROM integrations WHERE id = ? AND user_id = ?
    `).get(database.lastInsertRowId, userId) as IntegrationRow | undefined;
    const integration = row ? toIntegration(row) : null;
    if (!integration) {
      return { success: false, error: "Failed to save integration" };
    }

    return { success: true, data: integration };
  } catch {
    return { success: false, error: "Failed to save integration" };
  }
}

type DeleteIntegrationArgs = {
  database: Database;
  userId: number;
  integrationId: number;
};

export function deleteIntegration({
  database,
  userId,
  integrationId,
}: DeleteIntegrationArgs): ServiceResult<null> {
  try {
    const result = database
      .prepare(`
        DELETE FROM integrations
        WHERE user_id = ? AND id = ?
      `)
      .run(userId, integrationId);

    if (result === 0) {
      return { success: false, error: "Integration not found" };
    }

    return { success: true, data: null };
  } catch {
    return { success: false, error: "Failed to delete integration" };
  }
}

export function setIntegrationSetup(
  database: Database,
  userId: number,
  chatId: number,
  kind: IntegrationKind,
  promptMessageId: number,
) {
  database.prepare(`
    INSERT INTO integration_setup_sessions (user_id, chat_id, kind, prompt_message_id)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(user_id, chat_id) DO UPDATE SET
      kind = excluded.kind, prompt_message_id = excluded.prompt_message_id
  `).run(userId, chatId, kind, promptMessageId);
}

export function getIntegrationSetup(
  database: Database,
  userId: number,
  chatId: number,
) {
  return database.prepare(`
    SELECT kind, prompt_message_id AS promptMessageId FROM integration_setup_sessions
    WHERE user_id = ? AND chat_id = ?
  `).get(userId, chatId) as
    | { kind: IntegrationKind; promptMessageId: number }
    | undefined;
}

export function clearIntegrationSetup(
  database: Database,
  userId: number,
  chatId: number,
) {
  database.prepare(
    "DELETE FROM integration_setup_sessions WHERE user_id = ? AND chat_id = ?",
  )
    .run(userId, chatId);
}
