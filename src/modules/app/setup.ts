import { validateEnv } from "../../utils/env.ts";
import { createBot } from "../bot/setup.ts";
import type { Database } from "../database/setup.ts";
import { connectToDb } from "../database/setup.ts";
import { startFlexSyncLoop } from "../integrations/ibkr/flex.ts";

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
    console.log(`Database opened`);
  } catch (error) {
    console.error("Error occurred while connecting to the database:", error);
    Deno.exit(2);
  }

  try {
    console.log("Starting bot...");
    const bot = createBot(database);

    await new Promise((resolve) =>
      bot.start({
        onStart: () => resolve(undefined),
      }),
    );
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
}
