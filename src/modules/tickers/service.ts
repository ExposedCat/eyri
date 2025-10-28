import type { Database } from "../database/setup.ts";
import { getAllUsers } from "../database/user.ts";
import type { TradenetRealtime } from "../tradernet/realtime.ts";

type GetAllTickersArgs = {
	database: Database;
	tradenetRealtime: TradenetRealtime;
};

export async function subscribeToAllTickers({
	database,
	tradenetRealtime,
}: GetAllTickersArgs) {
	const users = await getAllUsers(database);
	for (const user of users) {
		for (const position of user.positions) {
			tradenetRealtime.subscribe(position.ticker);
		}
	}
}
