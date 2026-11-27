import { connectToDb } from "./modules/database/setup.ts";
import { ensureYahooMappings } from "./modules/market_data/mappings.ts";
import {
  resolveBotUsernameFromToken,
  startWebHttpServer,
} from "./modules/web/server.ts";

const db = await connectToDb();
ensureYahooMappings(db);

const botUsername = Deno.env.get("EYRI_WEB_BOT_USERNAME")?.trim() ||
  await resolveBotUsernameFromToken(Deno.env.get("TOKEN"));

const server = startWebHttpServer(db, { botUsername });
if (!server) {
  console.error("Eyri Web is disabled (EYRI_WEB_PORT=0).");
  Deno.exit(1);
}
await server.finished;
