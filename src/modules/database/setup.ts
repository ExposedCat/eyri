import { type Collection, MongoClient } from "mongodb";
import type { Price } from "./price.ts";
import type { User } from "./user.ts";

export type Database = {
	user: Collection<User>;
	price: Collection<Price>;
};

export async function connectToDb() {
	const DB_CONNECTION_STRING = Deno.env.get("DB_CONNECTION_STRING");
	if (!DB_CONNECTION_STRING) {
		throw new Error("DB_CONNECTION_STRING environment variable is missing");
	}

	const client = new MongoClient(DB_CONNECTION_STRING);
	await client.connect();

	const mongoDb = client.db();
	const user = mongoDb.collection<User>("user");
	const price = mongoDb.collection<Price>("price");
	const database: Database = { user, price };

	return database;
}
