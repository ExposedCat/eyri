import { getAllIntegrations } from "./modules/database/integration.ts";
import { connectToDb } from "./modules/database/setup.ts";
import { fetchIntegrationPortfolio } from "./modules/integrations/service.ts";

async function main() {
  const database = await connectToDb();
  const integrations = getAllIntegrations(database);

  if (integrations.length === 0) {
    console.log("No integrations configured.");
    return;
  }

  for (const integration of integrations) {
    await fetchIntegrationPortfolio(database, integration);
  }

  console.log(`Checked ${integrations.length} integration(s).`);
}

try {
  await main();
} catch (error) {
  console.error("Integration healthcheck failed:", error);
  Deno.exit(1);
}
