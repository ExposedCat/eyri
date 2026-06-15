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

type UpsertIntegrationArgs = {
  database: Database;
  userId: number;
  kind: IntegrationKind;
  credentials: Record<string, unknown>;
};

export async function upsertIntegration({
  database,
  userId,
  kind,
  credentials,
}: UpsertIntegrationArgs): Promise<ServiceResult<Integration>> {
  try {
    database
      .prepare(`
        INSERT INTO integrations (user_id, kind, credentials_json)
        VALUES (?, ?, ?)
        ON CONFLICT(user_id, kind) DO UPDATE SET
          credentials_json = excluded.credentials_json,
          updated_at = CURRENT_TIMESTAMP
      `)
      .run(userId, kind, JSON.stringify(credentials));

    const integration = getUserIntegrations(database, userId).find(
      (item) => item.kind === kind,
    );
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
  kind: IntegrationKind;
};

export async function deleteIntegration({
  database,
  userId,
  kind,
}: DeleteIntegrationArgs): Promise<ServiceResult<null>> {
  try {
    const result = database
      .prepare(`
        DELETE FROM integrations
        WHERE user_id = ? AND kind = ?
      `)
      .run(userId, kind);

    if (result === 0) {
      return { success: false, error: "Integration not found" };
    }

    return { success: true, data: null };
  } catch {
    return { success: false, error: "Failed to delete integration" };
  }
}
