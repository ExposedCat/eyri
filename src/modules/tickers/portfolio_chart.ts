import { formatMoney, formatMoneyChange } from "../../utils/money.ts";
import type { IntegrationPortfolioPosition } from "../integrations/types.ts";
import { isStockPosition } from "./portfolio.ts";

export type PortfolioChart = {
	total: string;
	holdingsCount: number;
	holdings: {
		ticker: string;
		weight: number;
		value: string;
		change: number | null;
		returnLabel: string;
	}[];
};

export function buildPortfolioCharts(
	positions: IntegrationPortfolioPosition[],
): PortfolioChart[] {
	const currencies = new Map<
		string,
		Map<string, {
			value: number;
			cost: number | null;
			change: number | null;
		}>
	>();
	for (const position of positions.filter(isStockPosition)) {
		if (position.amount === 0) continue;
		const ticker = position.ticker.trim().toUpperCase();
		const currency = position.currency.trim().toUpperCase();
		const value = position.currentPrice === null
			? position.totalNow
			: position.currentPrice * position.amount;
		if (value === null || !Number.isFinite(value)) {
			throw new Error(`Current price unavailable for ${ticker}.`);
		}
		const cost = position.totalInput ??
			(position.averageUnitPrice === null
				? null
				: position.averageUnitPrice * position.amount);
		const change = cost === null ? position.unrealizedPnl : value - cost;
		const holdings = currencies.get(currency) ?? new Map();
		const existing = holdings.get(ticker);
		holdings.set(
			ticker,
			existing
				? {
					value: existing.value + value,
					cost: existing.cost === null || cost === null
						? null
						: existing.cost + Math.abs(cost),
					change: existing.change === null || change === null
						? null
						: existing.change + change,
				}
				: { value, cost: cost === null ? null : Math.abs(cost), change },
		);
		currencies.set(currency, holdings);
	}
	return [...currencies].sort(([first], [second]) =>
		first.localeCompare(second)
	).flatMap(([currency, entries]) => {
		const holdings = [...entries].sort((
			[firstTicker, first],
			[secondTicker, second],
		) =>
			Math.abs(second.value) - Math.abs(first.value) ||
			firstTicker.localeCompare(secondTicker)
		);
		const grossValue = holdings.reduce(
			(sum, [, holding]) => sum + Math.abs(holding.value),
			0,
		);
		if (grossValue === 0) return [];
		const total = holdings.reduce((sum, [, holding]) => sum + holding.value, 0);
		return [{
			total: formatMoney(total, currency),
			holdingsCount: holdings.length,
			holdings: holdings.map(([ticker, holding]) => ({
				ticker,
				weight: Math.abs(holding.value) / grossValue * 100,
				value: formatMoney(holding.value, currency, 0),
				change: holding.change,
				returnLabel:
					holding.change === null || holding.cost === null || holding.cost === 0
						? "?"
						: formatMoneyChange(holding.change / holding.cost * 100, "%", 1),
			})),
		}];
	});
}

export async function renderPortfolioChart(chart: PortfolioChart) {
	const process = new Deno.Command("python3", {
		args: [
			decodeURIComponent(
				new URL("./portfolio_chart.py", import.meta.url).pathname,
			),
		],
		stdin: "piped",
		stdout: "piped",
		stderr: "piped",
		signal: AbortSignal.timeout(30_000),
	}).spawn();
	const output = process.output();
	try {
		const writer = process.stdin.getWriter();
		await writer.write(new TextEncoder().encode(JSON.stringify(chart)));
		await writer.close();
		const result = await output;
		if (!result.success) {
			console.error(
				"Portfolio chart renderer failed:",
				new TextDecoder().decode(result.stderr),
			);
			throw new Error("Could not render the portfolio chart.");
		}
		return result.stdout;
	} catch (error) {
		await output.catch(() => undefined);
		throw error;
	}
}
