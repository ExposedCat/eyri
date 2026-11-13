import { equal, ok } from "node:assert/strict";
import { Database } from "@db/sqlite";
import { ensureSchema } from "../database/setup.ts";
import { createIntegration } from "../database/integration.ts";
import type { CustomContext } from "./types.ts";
import { replyUserError } from "./errors.ts";
import { UserFacingError } from "../../utils/user_error.ts";

Deno.test("error replies stay short while diagnostics retain causes and redact credentials", async () => {
  const db = new Database(":memory:");
  const original = console.error;
  const logs: string[] = [], replies: string[] = [];
  try {
    ensureSchema(db);
    db.exec("INSERT INTO users (user_id) VALUES (1)");
    createIntegration({
      database: db,
      userId: 1,
      kind: "f24",
      credentials: { secretKey: "private-secret", apiKey: "private-key" },
    });
    console.error = (...values) => {
      logs.push(values.join(" "));
    };
    const ctx = {
      db,
      api: { token: "private-bot-token" },
      update: { update_id: 77 },
      reply: async (text: string) => {
        replies.push(text);
      },
    } as unknown as CustomContext;
    await replyUserError(
      ctx,
      new UserFacingError("Freedom24: HTTP 401. Update /integrations.", {
        detail: "request used private-key",
        cause: new Error("private-secret private-bot-token"),
      }),
    );
    equal(replies[0], "Freedom24: HTTP 401. Update /integrations.");
    ok(logs[0].includes("Report error 77"));
    ok(logs[0].includes("Caused by:"));
    ok(!/private-secret|private-key|private-bot-token/.test(logs[0]));
    await replyUserError(ctx, new Error("unexpected implementation detail"));
    equal(replies[1], "Unexpected bot error (77). Send this code to admin.");
  } finally {
    console.error = original;
    db.close();
  }
});
