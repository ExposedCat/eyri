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
	const now = new Date();
	const earliestDatesByTicker = ctx.dbEntities.user.positions.reduce(
		(list, position) => {
			const ticker = position.ticker;
			const positionDate =
				position.date instanceof Date ? position.date : new Date(position.date);
			const previousDate = list[ticker];
			if (!previousDate || positionDate < previousDate) {
				list[ticker] = positionDate;
			}
			return list;
		},
		{} as Record<string, Date>,
	);

	const getMonthCount = (startDate: Date, endDate: Date) => {
		const monthDifference =
			(endDate.getFullYear() - startDate.getFullYear()) * 12 +
			(endDate.getMonth() - startDate.getMonth());
		return Math.max(1, monthDifference + 1);
	};

	const formatMoney = (value: number) => `$${value.toFixed(2)}`;

	const priceList = Object.entries(positions)
		.map(([ticker, { amount, cost }]) => {
			const currentPrice = prices[ticker]?.price;
			const oldestDate = earliestDatesByTicker[ticker];
			const monthCount = oldestDate ? getMonthCount(oldestDate, now) : 1;
			const totalInput = cost;
			if (!currentPrice) {
				const monthlyAverageInput = totalInput / monthCount;
				return [
					`${ticker} ? ?`,
					`${formatMoney(monthlyAverageInput)} (?) ? x ${monthCount}`,
					`${formatMoney(totalInput)} ➔ ?`,
				].join("\n");
			}

			const totalNow = amount * currentPrice;
			const totalChange = totalNow - totalInput;
			const totalPercentageChange =
				totalInput === 0 ? 0 : (totalChange / totalInput) * 100;
			const monthlyAveragePrice = totalInput / monthCount;
			const monthlyAveragePercentageChange =
				totalInput === 0 ? 0 : totalPercentageChange / monthCount;

			return [
				`${ticker} ${formatMoneyChange(totalChange)} ${formatMoneyChange(totalPercentageChange, "%")}`,
				`${formatMoney(monthlyAveragePrice)} (${formatMoney(currentPrice)}) ${formatMoneyChange(monthlyAveragePercentageChange, "%")} x ${monthCount}`,
				`${formatMoney(totalInput)} ➔ ${formatMoney(totalNow)}`,
			].join("\n");
		})
		.join("\n");

	if (priceList.length === 0) {
		await ctx.text("no_positions");
		return;
	}

	await ctx.reply(priceList);
});
