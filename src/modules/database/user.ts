import type { ServiceResult } from "../../utils/service.ts";
import type { Database } from "./setup.ts";

export type Position = {
	ticker: string;
	amount: number;
	price: number;
	date: Date;
};

export type User = {
	userId: number;
	positions: Position[];
};

export type UserCredentials = {
	apiKey: string;
	apiSecret: string;
	login: string;
	password: string;
};

export async function findOrCreateUser(
	database: Database,
	userId: number,
): Promise<User | null> {
	return await database.user.findOneAndUpdate(
		{ userId },
		{ $setOnInsert: { positions: [] } },
		{ returnDocument: "after", upsert: true },
	);
}

type AddPositionArgs = {
	database: Database;
	userId: number;
	ticker: string;
	price: number;
	amount: number;
};

export async function addPosition({
	database,
	userId,
	ticker,
	price,
	amount,
}: AddPositionArgs): Promise<ServiceResult<null>> {
	try {
		await database.user.updateOne(
			{ userId },
			{ $push: { positions: { ticker, price, amount, date: new Date() } } },
		);
		return { success: true, data: null };
	} catch {
		return { success: false, error: "Failed to add position" };
	}
}

export function getPositions(user: User) {
	return user.positions.reduce(
		(list, position) => {
			list[position.ticker] ??= { amount: 0, cost: 0 };
			list[position.ticker].amount += position.amount;
			list[position.ticker].cost += position.price;
			return list;
		},
		{} as Record<string, { amount: number; cost: number }>,
	);
}

export function getAllUsers(database: Database) {
	return database.user.find().toArray();
}
