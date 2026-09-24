import type { Database } from "./setup.ts";

export type RsuVesting = { date: string; amount: number };
export type RsuAward = {
	ticker: string;
	amount: number;
	price: number;
	awardDate: string;
	vesting: RsuVesting[];
};

export function saveRsuAward(
	database: Database,
	userId: number,
	award: RsuAward,
) {
	database.prepare(`
		INSERT INTO rsu_awards (user_id, ticker, amount, price, award_date, vesting_json)
		VALUES (?, ?, ?, ?, ?, ?)
	`).run(
		userId,
		award.ticker,
		award.amount,
		award.price,
		award.awardDate,
		JSON.stringify(award.vesting),
	);
}

export function getRsuAwards(database: Database, userId: number): RsuAward[] {
	const rows = database.prepare(`
		SELECT ticker, amount, price, award_date, vesting_json
		FROM rsu_awards WHERE user_id = ? ORDER BY award_date, id
	`).all(userId) as {
		ticker: string;
		amount: number;
		price: number;
		award_date: string;
		vesting_json: string;
	}[];
	return rows.map((row) => ({
		ticker: row.ticker,
		amount: row.amount,
		price: row.price,
		awardDate: row.award_date,
		vesting: JSON.parse(row.vesting_json),
	}));
}
