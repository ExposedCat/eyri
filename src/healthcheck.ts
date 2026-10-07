import { getAllIntegrations } from "./modules/database/integration.ts";
import { connectToDb, type Database } from "./modules/database/setup.ts";
import { fetchIntegrationPortfolio } from "./modules/integrations/service.ts";

export async function checkIntegrations(database: Database) {
  // IB Gateway requires user 2FA; its availability is not app health.
  const integrations = getAllIntegrations(database).filter(
    (integration) => integration.kind !== "ibkr",
  );

  if (integrations.length === 0) {
    console.log("No non-IBKR integrations configured.");
    return;
  }

  for (const integration of integrations) {
    await fetchIntegrationPortfolio(database, integration);
  }

  console.log(`Checked ${integrations.length} integration(s).`);
}

if (import.meta.main) {
  try {
    await checkIntegrations(await connectToDb());
  } catch (error) {
    console.error("Integration healthcheck failed:", error);
    Deno.exit(1);
  }
}
