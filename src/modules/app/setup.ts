import { validateEnv } from "../../utils/env.ts";
import { createBot, setupBotCommands } from "../bot/setup.ts";
import { runBot } from "../bot/runtime.ts";
import type { Database } from "../database/setup.ts";
import { connectToDb } from "../database/setup.ts";
import { startIbkrExecutionSyncLoop } from "../integrations/ibkr/adapter.ts";
import { startFlexSyncLoop } from "../integrations/ibkr/flex_sync.ts";
import { startGatewayWatchdog } from "../integrations/ibkr/watchdog.ts";
import { ensureTickerDisplaySchema } from "../tickers/decorations.ts";
import { startMcpHttpServer } from "../mcp/server.ts";
import { ensureYahooMappings } from "../market_data/mappings.ts";
import { startWebHttpServer } from "../web/server.ts";

export async function startApp() {
  try {
    validateEnv(["TOKEN"]);
  } catch (error) {
    console.error("Error occurred while loading environment:", error);
    Deno.exit(1);
  }

  let database: Database;
  try {
    console.log("Opening database...");
    database = await connectToDb();
    ensureTickerDisplaySchema(database);
    ensureYahooMappings(database);
    console.log(`Database opened`);
  } catch (error) {
    console.error("Error occurred while connecting to the database:", error);
    Deno.exit(2);
  }

  try {
    const mcp = startMcpHttpServer(database);
    mcp?.finished.catch((error) => {
      console.error("MCP server stopped:", error);
      Deno.exit(5);
    });
  } catch (error) {
    console.error("Error occurred while starting MCP:", error);
    Deno.exit(5);
  }

  let botUsername: string | null = Deno.env.get("EYRI_WEB_BOT_USERNAME")?.trim() || null;

  try {
    console.log("Starting bot...");
    const bot = createBot(database);
    await bot.init();
    if (!botUsername && bot.botInfo?.username) {
      botUsername = bot.botInfo.username;
    }
    await bot.api.deleteWebhook();
    await setupBotCommands(bot);

    const runner = runBot(bot);
    runner.task()?.catch((error) => {
      console.error("Bot polling stopped:", error);
      Deno.exit(4);
    });
    console.log("Bot started");
  } catch (error) {
    console.error("Error occurred while starting the bot:", error);
    Deno.exit(4);
  }

  try {
    const web = startWebHttpServer(database, { botUsername });
    web?.finished.catch((error) => {
      console.error("Web server stopped:", error);
      Deno.exit(6);
    });
  } catch (error) {
    console.error("Error occurred while starting Web server:", error);
    Deno.exit(6);
  }

  try {
    console.log("Starting Flex sync loop...");
    startFlexSyncLoop(database);
    console.log("Flex sync loop started");
  } catch (error) {
    console.error("Error occurred while starting Flex sync loop:", error);
  }

  try {
    console.log("Starting IBKR execution sync loop...");
    startIbkrExecutionSyncLoop(database);
    startGatewayWatchdog(database);
    console.log("IBKR execution sync loop started");
  } catch (error) {
    console.error(
      "Error occurred while starting IBKR execution sync loop:",
      error,
    );
  }
}
