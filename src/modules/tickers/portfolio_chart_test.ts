import { deepStrictEqual, equal, ok, rejects } from "node:assert/strict";
import type { IntegrationPortfolioPosition } from "../integrations/types.ts";
import {
	buildPortfolioChart,
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

Deno.test("portfolio chart uses preferred currency for values and gains with unchanged weights and returns", async () => {
  const positions = [position("US", 100, 80), position("EU", 80, 40, { currency: "EUR" })];
  const request: typeof fetch = async () => Response.json({ base: "USD", quote: "EUR", rate: .8 });
  const usd = await buildPortfolioChart(positions, request);
  const eur = await buildPortfolioChart(positions, request, "EUR");
  ok(usd); ok(eur);
  equal(eur.total, "160.00 EUR");
  deepStrictEqual(eur.holdings.map((h) => [h.weight, h.returnLabel]), usd.holdings.map((h) => [h.weight, h.returnLabel]));
  equal(eur.holdings[0].value, "80 EUR");
  equal(eur.holdings[0].changeLabel, "+16.00 EUR");
});

Deno.test("portfolio chart sorts by share and measures gain or loss against purchase cost", async () => {
	const chart = await buildPortfolioChart([
		position("AAPL", 17000, 15000),
		position("MSFT", 22000, 24000),
		position("NVDA", 28000, 20000),
		position("+AAPL.25SEP2026.C200", 3000, 1000),
		position("CLOSED", 0, 0, { amount: 0 }),
	]);
	ok(chart);
	equal(chart.total, "$67,000.00");
	equal(chart.holdingsCount, 3);
	deepStrictEqual(chart.holdings.map((holding) => holding.ticker), [
		"NVDA",
		"MSFT",
		"AAPL",
	]);
	equal(chart.holdings[1].change, -2000);
	equal(chart.holdings[1].returnLabel, "-8.3%");
	equal(chart.holdings[0].changeLabel, "+$8,000.00");
	equal(chart.holdings[1].changeLabel, "-$2,000.00");
	ok(
		Math.abs(
			chart.holdings.reduce((sum, holding) => sum + holding.weight, 0) -
				100,
		) < 1e-9,
	);
});

Deno.test("portfolio chart converts currencies to USD before merging tickers", async () => {
	const chart = await buildPortfolioChart([
		position("AAPL", 10000, 5000),
		position("aapl", 5000, 5000, { integrationId: 2 }),
		position("SAP", 1000, 800, { currency: "EUR" }),
		position("AAPL", 800, 400, { currency: "EUR", integrationId: 3 }),
	], async () => Response.json({ base: "USD", quote: "EUR", rate: .8 }));
	ok(chart);
	equal(chart.holdingsCount, 2);
	equal(chart.total, "$17,250.00");
	equal(chart.holdings[0].ticker, "AAPL");
	equal(chart.holdings[0].value, "$16,000");
	equal(chart.holdings[0].returnLabel, "+52.4%");
	equal(chart.holdings[0].changeLabel, "+$5,500.00");
	equal(chart.holdings[1].value, "$1,250");
	equal(chart.holdings[1].changeLabel, "+$250.00");
	equal(chart.holdings[1].returnLabel, "+25.0%");
	ok(Math.abs(chart.holdings[0].weight - 16000 / 17250 * 100) < 1e-9);
});

Deno.test("portfolio chart handles unknown cost and short positions without inventing returns", async () => {
	const chart = await buildPortfolioChart([
		position("UNKNOWN", 10000, null),
		position("SHORT", 8000, -10000, { amount: -1 }),
	]);
	ok(chart);
	equal(chart.total, "$2,000.00");
	equal(chart.holdings[0].returnLabel, "?");
	equal(chart.holdings[0].change, null);
	equal(chart.holdings[0].changeLabel, "?");
	equal(chart.holdings[1].change, 2000);
	equal(chart.holdings[1].returnLabel, "+20.0%");
	equal(chart.holdings[1].value, "-$8,000");
	equal(chart.holdings[1].changeLabel, "+$2,000.00");
	await rejects(
		() =>
			buildPortfolioChart([
				position("MISSING", 0, 1, { currentPrice: null, totalNow: null }),
			]),
		/Current price unavailable for MISSING/,
	);
	equal(await buildPortfolioChart([]), null);
	equal(await buildPortfolioChart([position("ZERO", 0, 1)]), null);
});

Deno.test("one USD chart combines USD, EUR, GBP and pence with weights based on converted values", async () => {
	const calls: string[] = [];
	const chart = await buildPortfolioChart([
		position("US", 20, 10),
		position("EU", 8, 6, { currency: "EUR" }),
		position("POUNDS", 4, 5, { currency: "GBP" }),
		position("PENCE", 400, 500, { currency: "GBX" }),
		position("BROKER", 0, null, {
			currency: "GBX",
			currentPrice: null,
			totalNow: 200,
			unrealizedPnl: 50,
		}),
	], async (input) => {
		calls.push(String(input));
		const quote = String(input).endsWith("gbp") ? "GBP" : "EUR";
		return Response.json({
			base: "USD",
			quote,
			rate: quote === "GBP" ? .5 : .8,
		});
	});
	ok(chart);
	equal(chart.total, "$50.00");
	equal(chart.holdingsCount, 5);
	deepStrictEqual(chart.holdings.map((holding) => holding.ticker), [
		"US",
		"EU",
		"PENCE",
		"POUNDS",
		"BROKER",
	]);
	deepStrictEqual(chart.holdings.map((holding) => holding.weight), [
		40,
		20,
		16,
		16,
		8,
	]);
	for (const converted of chart.holdings.slice(2, 4)) {
		equal(converted.value, "$8");
		equal(converted.changeLabel, "-$2.00");
		equal(converted.returnLabel, "-20.0%");
	}
	equal(chart.holdings[4].value, "$4");
	equal(chart.holdings[4].changeLabel, "+$1.00");
	equal(chart.holdings[4].returnLabel, "?");
	equal(calls.filter((url) => url.endsWith("gbp")).length, 1);
});

Deno.test("USD charts skip FX for excluded holdings and never return a partial chart after an FX failure", async () => {
	const chart = await buildPortfolioChart([
		position("US", 100, 80),
		position("CLOSED", 10, 8, { currency: "EUR", amount: 0 }),
		position("+AAPL.25SEP2026.C200", 10, 8, { currency: "GBP" }),
	], () => {
		throw new Error("Unexpected request");
	});
	ok(chart);
	equal(chart.total, "$100.00");
	equal(chart.holdingsCount, 1);
	await rejects(
		buildPortfolioChart([
			position("US", 100, 80),
			position("EU", 100, 80, { currency: "EUR" }),
		], async () => new Response(null, { status: 503 })),
		/Could not load USD exchange rate for EUR/,
	);
});

Deno.test("monetary returns retain known broker gains without cost and zero changes", async () => {
	const chart = await buildPortfolioChart([
		position("UNKNOWN_COST", 1000, null, { unrealizedPnl: 12.5 }),
		position("FLAT", 100, 100),
	]);
	ok(chart);
	equal(chart.holdings[0].returnLabel, "?");
	equal(chart.holdings[0].changeLabel, "+$12.50");
	equal(chart.holdings[1].returnLabel, "0.0%");
	equal(chart.holdings[1].changeLabel, "$0.00");
});

Deno.test("portfolio renderer produces a high-resolution PNG for the approved layout", async () => {
	const chart = await buildPortfolioChart([
		position("NVDA", 28000, 20000),
		position("MSFT", 22000, 24000),
		position("AAPL", 17000, 15000),
		position("GOOGL", 12000, 10000),
		position("TSLA", 9000, 11000),
		position("AMZN", 7000, 6000),
		position("DIS", 5000, 6000),
	]);
	ok(chart);
	const png = await renderPortfolioChart(chart);
	deepStrictEqual([...png.slice(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
	const dimensions = new DataView(png.buffer, png.byteOffset);
	equal(dimensions.getUint32(16), 2400);
	equal(dimensions.getUint32(20), 1600);
	ok(png.length < 10 * 1024 * 1024);
});

Deno.test("long portfolios render all holdings in one wider PNG", async () => {
	const chart = await buildPortfolioChart(
		Array.from(
			{ length: 24 },
			(_, index) => position(`STOCK${index + 1}`, 24000 - index * 1000, 12000),
		),
	);
	ok(chart);
	equal(chart.holdings.length, 24);
	const png = await renderPortfolioChart(chart);
	deepStrictEqual([...png.slice(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
	const dimensions = new DataView(png.buffer, png.byteOffset);
	equal(dimensions.getUint32(16), 6160);
	equal(dimensions.getUint32(20), 1600);
	ok(png.length < 10 * 1024 * 1024);
});
