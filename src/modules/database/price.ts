import type { Database } from "./setup.ts";

export type Price = {
	ticker: string;
	price: number;
	date: Date;
};

type SavePriceArgs = {
	database: Database;
	ticker: string;
	price: number;
	closePrice?: number;
};

export async function savePrice({
	database,
	ticker,
	price,
	closePrice,
}: SavePriceArgs) {
	await database.price.updateOne(
		{ ticker },
		{
			$set: {
				ticker,
				price,
				closePrice,
				date: new Date(),
			},
		},
		{ upsert: true },
	);
}

export async function getPrices(
	database: Database,
	tickers: string[],
): Promise<Record<string, Price | null>> {
	const prices = await database.price
		.find({ ticker: { $in: tickers } })
		.toArray();

	return Object.fromEntries(
		tickers.map((ticker) => [
			ticker,
			prices.find((price) => price.ticker === ticker) ?? null,
		]),
	);
}
