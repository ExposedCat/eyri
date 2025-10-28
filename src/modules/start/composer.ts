import { Composer } from "grammy";

import type { CustomContext } from "../bot/types.ts";

export const startComposer = new Composer<CustomContext>();

startComposer.command("start", async (ctx) => {
	await ctx.text("start");
});
