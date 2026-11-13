import { deepStrictEqual, equal } from "node:assert/strict";
import { Database } from "@db/sqlite";
import { ensureSchema } from "./setup.ts";
import { findOrCreateUser, setUserCurrency } from "./user.ts";
import { openDatabase } from "../storage/sqlite.ts";

Deno.test("existing users require no write even while another connection holds the write lock", async () => {
  const dir = Deno.makeTempDirSync();
  const path = `${dir}/test.sqlite`;
  const writer = openDatabase(path);
  const reader = new Database(path);
  try {
    ensureSchema(writer);
    deepStrictEqual(await findOrCreateUser(writer, 1), {
      userId: 1,
      currency: null,
    });
    setUserCurrency(writer, 1, "EUR");
    writer.exec("UPDATE users SET updated_at = '2020-01-01'; BEGIN IMMEDIATE");
    const changes = reader.totalChanges;
    deepStrictEqual(await findOrCreateUser(reader, 1), {
      userId: 1,
      currency: "EUR",
    });
    equal(reader.totalChanges, changes);
    deepStrictEqual(
      reader.prepare("SELECT updated_at FROM users WHERE user_id=1").get(),
      { updated_at: "2020-01-01" },
    );
    writer.exec("ROLLBACK");
  } finally {
    reader.close();
    writer.close();
    Deno.removeSync(dir, { recursive: true });
  }
});
