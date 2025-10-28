import { validateEnv } from "../../utils/env.ts";
import { createBot } from "../bot/setup.ts";
import type { Database } from "../database/setup.ts";
import { connectToDb } from "../database/setup.ts";
import { TradenetRealtime } from "../tradernet/realtime.ts";

export async function startApp() {
	try {
		validateEnv(["TOKEN", "DB_CONNECTION_STRING", "TRADERNET_SID"]);
	} catch (error) {
		console.error("Error occurred while loading environment:", error);
		Deno.exit(1);
	}

	let database: Database;
	try {
		database = await connectToDb();
	} catch (error) {
		console.error("Error occurred while connecting to the database:", error);
		Deno.exit(2);
	}

	const tradenetRealtime = new TradenetRealtime(database);
	try {
		await tradenetRealtime.connect(Deno.env.get("TRADERNET_SID") ?? "");
	} catch (error) {
		console.error(
			"Error occurred while connecting to the Tradenet Realtime:",
			error,
		);
		Deno.exit(3);
	}

	try {
		const bot = createBot(database, tradenetRealtime);

		await new Promise((resolve) =>
			bot.start({
				onStart: () => resolve(undefined),
			}),
		);
	} catch (error) {
		console.error("Error occurred while starting the bot:", error);
		Deno.exit(4);
	}
}
