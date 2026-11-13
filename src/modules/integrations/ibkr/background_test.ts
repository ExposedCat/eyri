import { equal, match } from "node:assert/strict";
import { Database } from "@db/sqlite";
import { ensureSchema } from "../../database/setup.ts";
import { startIbkrExecutionSyncLoop } from "./adapter.ts";
import { startGatewayWatchdog } from "./watchdog.ts";

for (const start of [startIbkrExecutionSyncLoop, startGatewayWatchdog]) {
  Deno.test(`${start.name} survives a locked database and retries on the next tick`, async () => {
    const database = new Database(":memory:");
    const originalInterval = globalThis.setInterval;
    const originalError = console.error;
    const errors: unknown[][] = [];
    let tick!: () => Promise<void>;
    let reads = 0;
    try {
      ensureSchema(database);
      const prepare = database.prepare.bind(database);
      database.prepare = (sql) => {
        if (sql.includes("FROM integrations") && ++reads === 1) {
          throw new Error("database is locked");
        }
        return prepare(sql);
      };
      globalThis.setInterval = ((callback: () => Promise<void>) => {
        tick = callback;
        return 1;
      }) as typeof setInterval;
      console.error = (...args) => errors.push(args);
      start(database);
      await new Promise((resolve) => setTimeout(resolve, 0));
      equal(errors.length, 1);
      match(String(errors[0][1]), /database is locked/);
      await tick();
      equal(reads, 2);
      equal(errors.length, 1);
    } finally {
      globalThis.setInterval = originalInterval;
      console.error = originalError;
      database.close();
    }
  });
}
