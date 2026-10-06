import { deepStrictEqual, equal, ok, throws } from "node:assert/strict";
import type { IntegrationPortfolioPosition } from "../integrations/types.ts";
import {
	buildPortfolioCharts,
	renderPortfolioChart,
} from "./portfolio_chart.ts";

function position(
	ticker: string,
	value: number,
	cost: number | null,
	overrides: Partial<IntegrationPortfolioPosition> = {},
): IntegrationPortfolioPosition {
	return {
		integrationId: 1,
		integrationKind: "ibkr",
		account: "test",
		ticker,
		amount: 1,
		currentPrice: value,
		averageUnitPrice: cost,
		currency: "USD",
		totalInput: cost,
		totalNow: value,
		unrealizedPnl: null,
		realizedPnl: null,
		dailyPnl: null,
		dailyPnlPercentage: null,
		dailyPnlBaseline: null,
		openedAt: null,
		...overrides,
	};
}

Deno.test("portfolio chart sorts by share and measures gain or loss against purchase cost", () => {
	const charts = buildPortfolioCharts([
		position("AAPL", 17000, 15000),
		position("MSFT", 22000, 24000),
		position("NVDA", 28000, 20000),
		position("+AAPL.25SEP2026.C200", 3000, 1000),
		position("CLOSED", 0, 0, { amount: 0 }),
	]);
	equal(charts.length, 1);
	equal(charts[0].total, "$67,000.00");
	equal(charts[0].holdingsCount, 3);
	deepStrictEqual(charts[0].holdings.map((holding) => holding.ticker), [
		"NVDA",
		"MSFT",
		"AAPL",
	]);
	equal(charts[0].holdings[1].change, -2000);
	equal(charts[0].holdings[1].returnLabel, "-8.3%");
	equal(charts[0].holdings[0].changeLabel, "+$8,000.00");
	equal(charts[0].holdings[1].changeLabel, "-$2,000.00");
	ok(
		Math.abs(
			charts[0].holdings.reduce((sum, holding) => sum + holding.weight, 0) -
				100,
		) < 1e-9,
	);
});

Deno.test("portfolio chart merges ticker values and separates currencies", () => {
	const charts = buildPortfolioCharts([
		position("AAPL", 10000, 5000),
		position("aapl", 5000, 5000, { integrationId: 2 }),
		position("SAP", 1000, 800, { currency: "EUR" }),
	]);
	equal(charts.length, 2);
	equal(charts[0].total, "1,000.00 EUR");
	equal(charts[0].holdings[0].changeLabel, "+200.00 EUR");
	equal(charts[1].holdingsCount, 1);
	equal(charts[1].total, "$15,000.00");
	equal(charts[1].holdings[0].returnLabel, "+50.0%");
	equal(charts[1].holdings[0].changeLabel, "+$5,000.00");
});

Deno.test("portfolio chart handles unknown cost and short positions without inventing returns", () => {
	const charts = buildPortfolioCharts([
		position("UNKNOWN", 10000, null),
		position("SHORT", 8000, -10000, { amount: -1 }),
	]);
	equal(charts[0].total, "$2,000.00");
	equal(charts[0].holdings[0].returnLabel, "?");
	equal(charts[0].holdings[0].change, null);
	equal(charts[0].holdings[0].changeLabel, "?");
	equal(charts[0].holdings[1].change, 2000);
	equal(charts[0].holdings[1].returnLabel, "+20.0%");
	equal(charts[0].holdings[1].value, "-$8,000");
	equal(charts[0].holdings[1].changeLabel, "+$2,000.00");
	throws(
		() =>
			buildPortfolioCharts([
				position("MISSING", 0, 1, { currentPrice: null, totalNow: null }),
			]),
		/Current price unavailable for MISSING/,
	);
	deepStrictEqual(buildPortfolioCharts([]), []);
	deepStrictEqual(buildPortfolioCharts([position("ZERO", 0, 1)]), []);
});

Deno.test("monetary returns retain known broker gains without cost and zero changes", () => {
	const chart = buildPortfolioCharts([
		position("UNKNOWN_COST", 1000, null, { unrealizedPnl: 12.5 }),
		position("FLAT", 100, 100),
	])[0];
	equal(chart.holdings[0].returnLabel, "?");
	equal(chart.holdings[0].changeLabel, "+$12.50");
	equal(chart.holdings[1].returnLabel, "0.0%");
	equal(chart.holdings[1].changeLabel, "$0.00");
});

Deno.test("portfolio renderer produces a high-resolution PNG for the approved layout", async () => {
	const chart = buildPortfolioCharts([
		position("NVDA", 28000, 20000),
		position("MSFT", 22000, 24000),
		position("AAPL", 17000, 15000),
		position("GOOGL", 12000, 10000),
		position("TSLA", 9000, 11000),
		position("AMZN", 7000, 6000),
		position("DIS", 5000, 6000),
	])[0];
	const png = await renderPortfolioChart(chart);
	deepStrictEqual([...png.slice(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
	const dimensions = new DataView(png.buffer, png.byteOffset);
	equal(dimensions.getUint32(16), 2400);
	equal(dimensions.getUint32(20), 1600);
	ok(png.length < 10 * 1024 * 1024);
});

Deno.test("long portfolios render all holdings in one wider PNG", async () => {
	const charts = buildPortfolioCharts(
		Array.from({ length: 24 }, (_, index) =>
			position(`STOCK${index + 1}`, 24000 - index * 1000, 12000)
		),
	);
	equal(charts.length, 1);
	equal(charts[0].holdings.length, 24);
	const png = await renderPortfolioChart(charts[0]);
	deepStrictEqual([...png.slice(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
	const dimensions = new DataView(png.buffer, png.byteOffset);
	equal(dimensions.getUint32(16), 6160);
	equal(dimensions.getUint32(20), 1600);
	ok(png.length < 10 * 1024 * 1024);
});
