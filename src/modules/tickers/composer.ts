import { Composer } from "grammy";
import { formatMoneyChange } from "../../utils/money.ts";
import type { CustomContext } from "../bot/types.ts";
import { getPrices } from "../database/price.ts";
import { addPosition, getPositions } from "../database/user.ts";

export const tickersComposer = new Composer<CustomContext>();

tickersComposer.command("buy", async (ctx) => {
	if (!ctx.dbEntities.user) {
		await ctx.text("start");
		return;
	}

	if (!ctx.match) {
		await ctx.text("buy");
		return;
	}

	const params = ctx.match.split(" ");
	if (params.length !== 4) {
		await ctx.text("buy");
		return;
	}

	const [ticker, price, commission, amount] = params;

	const result = await addPosition({
		database: ctx.db,
		userId: ctx.dbEntities.user.userId,
		ticker,
		price: Number(price) + Number(commission),
		amount: Number(amount),
	});

	if (!result.success) {
		await ctx.text("buy");
		return;
	}

	ctx.tradenetRealtime.subscribe(ticker);

	await ctx.text("bought");
});

tickersComposer.command("tickers", async (ctx) => {
	if (!ctx.dbEntities.user) {
		await ctx.text("start");
		return;
	}

	const prices = await getPrices(
		ctx.db,
		ctx.dbEntities.user.positions.map((position) => position.ticker),
	);

	const positions = getPositions(ctx.dbEntities.user);

	const priceList = Object.entries(positions)
		.map(([ticker, { amount, cost }]) => {
			const price = prices[ticker]?.price;
			if (!price) {
				return `${ticker} ${amount}x $?`;
			}

			const totalPrice = amount * price;
			const profit = totalPrice - cost;
			const profitPercentage = (profit / cost) * 100;

			return `${ticker} ${formatMoneyChange(profit)} ${formatMoneyChange(profitPercentage, "%")} ($${totalPrice})`;
		})
		.join("\n");

	if (priceList.length === 0) {
		await ctx.text("no_positions");
		return;
	}

	await ctx.reply(priceList);
});
