import { deepStrictEqual, equal, ok } from "node:assert/strict";
import { Database } from "@db/sqlite";
import { ensureSchema } from "./setup.ts";
import {
  clearIntegrationSetup,
  createIntegration,
  deleteIntegration,
  getIntegrationSetup,
  getUserIntegrations,
  setIntegrationSetup,
} from "./integration.ts";

Deno.test("integration migration preserves IDs, credentials, history and deleted ID sequence", async () => {
  for (const empty of [false, true]) {
    const db = new Database(":memory:");
    try {
      db.exec(`
        CREATE TABLE users (user_id INTEGER PRIMARY KEY);
        INSERT INTO users VALUES (1);
        CREATE TABLE integrations (
          id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL,
          kind TEXT NOT NULL, credentials_json TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (user_id) REFERENCES users(user_id), UNIQUE(user_id, kind)
        );
        INSERT INTO integrations VALUES (7, 1, 'f24', '{"apiKey":"original"}', '2025-01-01', '2025-01-02');
        INSERT INTO integrations VALUES (40, 1, 'ibkr', '{}', '2025-01-01', '2025-01-02');
        DELETE FROM integrations WHERE id = 40;
        CREATE TABLE ibkr_flex_trades (integration_id INTEGER, trade_key TEXT);
        INSERT INTO ibkr_flex_trades VALUES (7, 'trade-1');
      `);
      if (empty) db.exec("DELETE FROM integrations");
      ensureSchema(db);
      ensureSchema(db);
      const existing = getUserIntegrations(db, 1);
      equal(existing.length, empty ? 0 : 1);
      if (!empty) {
        equal(existing[0].id, 7);
        deepStrictEqual(existing[0].credentials, { apiKey: "original" });
        equal(existing[0].createdAt.toISOString(), "2025-01-01T00:00:00.000Z");
      }
      deepStrictEqual(db.prepare("SELECT * FROM ibkr_flex_trades").all(), [{
        integration_id: 7,
        trade_key: "trade-1",
      }]);
      for (const kind of ["f24", "f24", "ibkr", "ibkr"] as const) {
        const result = await createIntegration({
          database: db,
          userId: 1,
          kind,
          credentials: { account: kind },
        });
        ok(result.success);
        ok(result.data);
        ok(result.data.id > 40);
      }
      equal(getUserIntegrations(db, 1).length, empty ? 4 : 5);
    } finally {
      db.close();
    }
  }
});

Deno.test("delete targets one owned account; setup state is scoped to user and chat", async () => {
  const db = new Database(":memory:");
  try {
    ensureSchema(db);
    db.exec("INSERT INTO users (user_id) VALUES (1), (2)");
    for (const userId of [1, 1, 2]) {
      ok(
        (await createIntegration({
          database: db,
          userId,
          kind: "f24",
          credentials: {},
        })).success,
      );
    }
    equal(
      (await deleteIntegration({ database: db, userId: 2, integrationId: 1 }))
        .success,
      false,
    );
    equal(
      (await deleteIntegration({ database: db, userId: 1, integrationId: 1 }))
        .success,
      true,
    );
    equal(
      (await deleteIntegration({ database: db, userId: 1, integrationId: 1 }))
        .success,
      false,
    );
    deepStrictEqual(getUserIntegrations(db, 1).map((item) => item.id), [2]);
    deepStrictEqual(getUserIntegrations(db, 2).map((item) => item.id), [3]);
    setIntegrationSetup(db, 1, 100, "ibkr", 20);
    setIntegrationSetup(db, 1, 200, "f24", 30);
    setIntegrationSetup(db, 2, 100, "f24", 40);
    setIntegrationSetup(db, 1, 100, "f24", 50);
    deepStrictEqual(getIntegrationSetup(db, 1, 100), {
      kind: "f24",
      promptMessageId: 50,
    });
    clearIntegrationSetup(db, 1, 100);
    equal(getIntegrationSetup(db, 1, 100), undefined);
    equal(getIntegrationSetup(db, 1, 200)?.promptMessageId, 30);
    equal(getIntegrationSetup(db, 2, 100)?.promptMessageId, 40);
  } finally {
    db.close();
  }
});

Deno.test("Trading 212 migration preserves existing credential-entry sessions", () => {
  const db = new Database(":memory:");
  try {
    db.exec(`
      CREATE TABLE users (user_id INTEGER PRIMARY KEY);
      INSERT INTO users VALUES (1);
      CREATE TABLE integration_setup_sessions (
        user_id INTEGER NOT NULL REFERENCES users(user_id),
        chat_id INTEGER NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('ibkr', 'f24')),
        prompt_message_id INTEGER NOT NULL,
        PRIMARY KEY (user_id, chat_id)
      );
      INSERT INTO integration_setup_sessions VALUES (1, 10, 'f24', 20);
    `);
    ensureSchema(db);
    ensureSchema(db);
    deepStrictEqual(getIntegrationSetup(db, 1, 10), {
      kind: "f24",
      promptMessageId: 20,
    });
    setIntegrationSetup(db, 1, 11, "t212", 21);
    deepStrictEqual(getIntegrationSetup(db, 1, 11), {
      kind: "t212",
      promptMessageId: 21,
    });
    const result = createIntegration({
      database: db,
      userId: 1,
      kind: "t212",
      credentials: { apiKey: "key", secretKey: "secret" },
    });
    ok(result.success);
    equal(getUserIntegrations(db, 1)[0].kind, "t212");
  } finally {
    db.close();
  }
});
