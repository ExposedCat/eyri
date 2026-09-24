import { deepStrictEqual, equal, throws } from "node:assert/strict";
import { connectToDb } from "../database/setup.ts";
import {
	getRsuAwards,
	removeRsuAwards,
	saveRsuAward,
} from "../database/rsu.ts";
import { formatDecoratedTicker } from "./decorations.ts";
import {
	buildRsuGroups,
	buildRsuSummary,
	formatRsuTimeLeft,
	getRsuView,
	parseRsuAward,
	parseRsuDate,
} from "./rsu.ts";

Deno.test("RSU parsing validates dates and reconciles fractional vesting amounts", () => {
	const award = parseRsuAward(
		"aapl 0.3 100 29.02.24\r\n01.03.26 0.2\r\n01.03.25 0.1",
	);
	equal(award.ticker, "AAPL");
	equal(award.awardDate, "2024-02-29");
	deepStrictEqual(award.vesting, [{ date: "2025-03-01", amount: 0.1 }, {
		date: "2026-03-01",
		amount: 0.2,
	}]);
	for (
		const input of [
			"AAPL 10 100 29.02.25\n01.03.26 10",
			"AAPL 10 100 01.01.25\n31.04.26 10",
			"AAPL 10 100 01.01.25\n01.01.24 10",
			"AAPL 10 100 01.01.25\n01.01.26 9",
			"AAPL 10 100 01.01.25\n01.01.26 11",
			"AAPL 10 0 01.01.25\n01.01.26 10",
			"AAPL -10 100 01.01.25\n01.01.26 -10",
			"AAPL 10 100 01.01.25",
			"<AAPL> 10 100 01.01.25\n01.01.26 10",
		]
	) throws(() => parseRsuAward(input));
});

Deno.test("RSU countdown uses UTC days and calendar months including leap years", () => {
	const now = new Date("2026-09-24T12:00:00Z");
	equal(formatRsuTimeLeft("2026-09-24", now), "today");
	equal(formatRsuTimeLeft("2026-09-25", now), "less than 1D");
	equal(formatRsuTimeLeft("2026-09-26", now), "2d");
	equal(formatRsuTimeLeft("2026-11-27", now), "2m 3d");
	equal(formatRsuTimeLeft("2028-11-27", now), "2y 2m 3d");
	equal(
		formatRsuTimeLeft("2024-02-29", new Date("2024-01-31T00:00:00Z")),
		"1m 0d",
	);
	equal(
		formatRsuTimeLeft("2025-02-28", new Date("2024-02-29T00:00:00Z")),
		"1y 0m 0d",
	);
});

Deno.test("RSUs group by vesting date and ticker with weighted award cost and existing decorations", () => {
	const now = new Date("2026-09-24T12:00:00Z");
	const awards = [
		parseRsuAward("AAPL 20 100 01.01.25\n23.09.26 10\n24.09.26 10"),
		parseRsuAward("AAPL 10 200 01.01.25\n24.09.26 10"),
		parseRsuAward("MSFT 2 100 01.01.25\n26.09.26 2"),
	];
	const vestings = getRsuView(awards, now).upcoming;
	equal(vestings.length, 3);
	const formatter = (ticker: string) =>
		formatDecoratedTicker(ticker, {}, { AAPL: "Apple" }, {
			AAPL: "https://example.com",
		}, {});
	const groups = buildRsuGroups(
		vestings,
		new Map([["AAPL", 180], ["MSFT", 50]]),
		formatter,
		now,
	);
	equal(
		groups[0],
		`24.09.2026 (today)\n${formatter("AAPL")} $3,600.00 (+$600.00 +20.00%)`,
	);
	equal(
		groups[1],
		`26.09.2026 (2d)\n${formatter("MSFT")} $100.00 (-$100.00 -50.00%)`,
	);
	const unavailable = buildRsuGroups(vestings, new Map(), formatter, now);
	equal(unavailable[0], `24.09.2026 (today)\n${formatter("AAPL")} ? (? ?)`);
	const flat = buildRsuGroups(
		vestings,
		new Map([["AAPL", 150]]),
		formatter,
		now,
	);
	equal(
		flat[0],
		`24.09.2026 (today)\n${formatter("AAPL")} $3,000.00 ($0.00 0.00%)`,
	);
});

Deno.test("RSU awards persist separately for each user", async () => {
	Deno.env.set("EYRI_DATABASE_PATH", ":memory:");
	const database = await connectToDb();
	try {
		database.exec("INSERT INTO users (user_id) VALUES (1), (2)");
		const award = parseRsuAward("AAPL 10 100 01.01.25\n24.09.26 10");
		saveRsuAward(database, 1, award);
		deepStrictEqual(getRsuAwards(database, 1), [award]);
		deepStrictEqual(getRsuAwards(database, 2), []);
		saveRsuAward(database, 1, award);
		saveRsuAward(database, 2, award);
		const otherAward = { ...award, ticker: "MSFT" };
		saveRsuAward(database, 1, otherAward);
		removeRsuAwards(database, 1, "aapl");
		deepStrictEqual(getRsuAwards(database, 1), [otherAward]);
		deepStrictEqual(getRsuAwards(database, 2), [award]);
		removeRsuAwards(database, 1, "AAPL");
		deepStrictEqual(getRsuAwards(database, 1), [otherAward]);
	} finally {
		database.close();
		Deno.env.delete("EYRI_DATABASE_PATH");
	}
});

Deno.test("RSU totals sum listed vestings and preserve inclusive cutoff totals", () => {
	const awards = [
		parseRsuAward(
			"AAPL 40 100 25.09.25\n24.09.26 10\n25.09.26 10\n25.10.26 10\n25.11.26 10",
		),
		parseRsuAward("AAPL 10 200 25.10.25\n25.09.26 5\n25.10.26 5"),
	];
	const original = JSON.stringify(awards);
	const prices = new Map([["AAPL", 150]]);
	const now = new Date("2026-09-25T12:00:00Z");
	const regular = getRsuView(awards, now);
	equal(regular.total.length, 5);
	deepStrictEqual(regular.total, regular.upcoming);
	equal(regular.upcoming.length, 5);
	equal(regular.missed.length, 0);
	equal(
		buildRsuSummary(
			"Total",
			regular.total,
			prices,
			regular.start,
			regular.end,
		),
		"Total: $6,000.00 (+$1,000.00 +20.00%) over 1y 2m 0d",
	);
	const cutoff = parseRsuDate("25.10.2026");
	const view = getRsuView(awards, now, cutoff);
	equal(view.total.length, 5);
	equal(view.upcoming.length, 4);
	equal(view.missed.length, 1);
	equal(
		buildRsuSummary("Total", view.total, prices, view.start, view.end),
		"Total: $6,000.00 (+$1,000.00 +20.00%) over 1y 1m 0d",
	);
	equal(
		buildRsuSummary("Missed", view.missed, prices, cutoff, view.lastVesting),
		"Missed: $1,500.00 (+$500.00 +50.00%) over 1m 0d",
	);
	equal(JSON.stringify(awards), original);
	throws(() => parseRsuDate("31.02.2026"));
});

Deno.test("RSU totals handle past cutoffs, completed awards, and missing prices without partial totals", () => {
	const awards = [
		parseRsuAward("AAPL 10 100 01.01.25\n01.06.25 5\n01.06.26 5"),
	];
	const now = new Date("2026-09-25T12:00:00Z");
	const completed = getRsuView(awards, now);
	equal(completed.upcoming.length, 0);
	equal(completed.total.length, 0);
	equal(
		buildRsuSummary(
			"Total",
			completed.total,
			new Map(),
			completed.start,
			completed.end,
		),
		"Total: $0.00 ($0.00 0.00%) over 0d",
	);
	const past = getRsuView(awards, now, "2025-06-01");
	equal(past.upcoming.length, 0);
	equal(past.total.length, 1);
	equal(past.missed.length, 1);
	const before = getRsuView(awards, now, "2024-01-01");
	equal(
		buildRsuSummary(
			"Total",
			before.total,
			new Map(),
			before.start,
			before.end,
		),
		"Total: $0.00 ($0.00 0.00%) over 0d",
	);
	const after = getRsuView(awards, now, "2027-01-01");
	equal(
		buildRsuSummary(
			"Missed",
			after.missed,
			new Map(),
			after.end,
			after.lastVesting,
		),
		"Missed: $0.00 ($0.00 0.00%) over 0d",
	);
	const mixed = getRsuView(
		[...awards, { ...awards[0], ticker: "MSFT" }],
		new Date("2026-01-01T00:00:00Z"),
	);
	equal(
		buildRsuSummary(
			"Total",
			mixed.total,
			new Map([["AAPL", 150]]),
			mixed.start,
			mixed.end,
		),
		"Total: ? (? ?) over 1y 5m 0d",
	);
});
