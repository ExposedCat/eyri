import { deepStrictEqual, ok, rejects } from "node:assert/strict";
import { Database } from "@db/sqlite";
import { checkIntegrations } from "./healthcheck.ts";
import { createIntegration } from "./modules/database/integration.ts";
import { ensureSchema } from "./modules/database/setup.ts";
import { freedom24Adapter } from "./modules/integrations/freedom24/adapter.ts";
import { ibkrAdapter } from "./modules/integrations/ibkr/adapter.ts";
import { trading212Adapter } from "./modules/integrations/trading212/adapter.ts";

Deno.test("healthcheck skips IBKR awaiting 2FA and still checks other brokers", async () => {
  const database = new Database(":memory:");
  const original = [
    ibkrAdapter.fetchPortfolio,
    freedom24Adapter.fetchPortfolio,
    trading212Adapter.fetchPortfolio,
  ] as const;
  const checked: string[] = [];
  try {
    ensureSchema(database);
    database.exec("INSERT INTO users (user_id) VALUES (1), (2)");
    ibkrAdapter.fetchPortfolio = () => {
      checked.push("ibkr");
      return Promise.reject(new Error("Waiting for 2FA"));
    };
    freedom24Adapter.fetchPortfolio =
      trading212Adapter.fetchPortfolio =
        (_database, integration) => {
          checked.push(integration.kind);
          return Promise.resolve([]);
        };

    await checkIntegrations(database);
    for (
      const [index, kind] of (["ibkr", "ibkr", "f24", "t212"] as const)
        .entries()
    ) {
      ok(
        createIntegration({
          database,
          userId: index % 2 + 1,
          kind,
          credentials: {},
        }).success,
      );
      if (index === 1) {
        await checkIntegrations(database);
        deepStrictEqual(checked, []);
      }
    }

    await checkIntegrations(database);
    deepStrictEqual(checked, ["f24", "t212"]);

    for (const adapter of [freedom24Adapter, trading212Adapter]) {
      const fetchPortfolio = adapter.fetchPortfolio;
      adapter.fetchPortfolio = () => Promise.reject(new Error("Unavailable"));
      await rejects(checkIntegrations(database), /Unavailable/);
      adapter.fetchPortfolio = fetchPortfolio;
    }
  } finally {
    [
      ibkrAdapter.fetchPortfolio,
      freedom24Adapter.fetchPortfolio,
      trading212Adapter.fetchPortfolio,
    ] = original;
    database.close();
  }
});
