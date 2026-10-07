import { validateEnv } from "../../utils/env.ts";
import { createBot, setupBotCommands } from "../bot/setup.ts";
import { runBot } from "../bot/runtime.ts";
import type { Database } from "../database/setup.ts";
import { connectToDb } from "../database/setup.ts";
import { startIbkrExecutionSyncLoop } from "../integrations/ibkr/adapter.ts";
import { startFlexSyncLoop } from "../integrations/ibkr/flex.ts";
import { ensureTickerDisplaySchema } from "../tickers/decorations.ts";
import { ensureYahooMappings } from "../market_data/mappings.ts";

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
    console.log("Starting bot...");
    const bot = createBot(database);
    await bot.init();
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
    console.log("Starting Flex sync loop...");
    startFlexSyncLoop(database);
    console.log("Flex sync loop started");
  } catch (error) {
    console.error("Error occurred while starting Flex sync loop:", error);
  }

  try {
    console.log("Starting IBKR execution sync loop...");
    startIbkrExecutionSyncLoop(database);
    console.log("IBKR execution sync loop started");
  } catch (error) {
    console.error(
      "Error occurred while starting IBKR execution sync loop:",
      error,
    );
  }
}
