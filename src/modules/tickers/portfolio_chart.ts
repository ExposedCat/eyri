import { formatMoney, formatMoneyChange } from "../../utils/money.ts";
import { portfolioPositionsInCurrency } from "../integrations/usd.ts";
import type { IntegrationPortfolioPosition } from "../integrations/types.ts";
import { isStockPosition } from "./portfolio.ts";
import { renderPortfolioAllocation } from "./portfolio_chart_renderer.ts";

export type PortfolioChart = {
	total: string;
	holdingsCount: number;
	holdings: {
		ticker: string;
		weight: number;
		value: string;
		change: number | null;
		returnLabel: string;
		changeLabel: string;
	}[];
};

export async function buildPortfolioAllocation(
	positions: IntegrationPortfolioPosition[],
	request: typeof fetch = fetch,
	currency = "USD",
) {
	const stocks = positions.filter((position) =>
		isStockPosition(position) && position.amount !== 0
	);
	const reported = await portfolioPositionsInCurrency(stocks, request, currency);
	const entries = new Map<
		string,
		{
			value: number;
			cost: number | null;
			change: number | null;
		}
	>();
	for (const position of reported) {
		const ticker = position.ticker.trim().toUpperCase();
		const nativeValue = position.brokerValuations || position.currentPrice === null
			? position.totalNow
			: position.currentPrice * position.amount;
		if (nativeValue === null || !Number.isFinite(nativeValue)) {
			throw new Error(`Current price unavailable for ${ticker}.`);
		}
		const value = nativeValue;
		const nativeCost = position.totalInput ??
			(position.averageUnitPrice === null
				? null
				: position.averageUnitPrice * position.amount);
		const cost = nativeCost;
		const nativeChange = position.brokerValuations || nativeCost === null
			? position.unrealizedPnl === null
				? null
				: position.unrealizedPnl
			: nativeValue - nativeCost;
		const change = nativeChange;
		const existing = entries.get(ticker);
		entries.set(
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
	}
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
	if (grossValue === 0) return null;
	const total = holdings.reduce((sum, [, holding]) => sum + holding.value, 0);
	return {
		total,
		holdingsCount: holdings.length,
		holdings: holdings.map(([ticker, holding]) => ({
			ticker,
			weight: Math.abs(holding.value) / grossValue * 100,
			value: holding.value,
			change: holding.change,
			returnPct: holding.change === null || holding.cost === null || holding.cost === 0
				? null : holding.change / holding.cost * 100,
		})),
	};
}

export async function buildPortfolioChart(
	positions: IntegrationPortfolioPosition[],
	request: typeof fetch = fetch,
	currency = "USD",
): Promise<PortfolioChart | null> {
	const allocation = await buildPortfolioAllocation(
		positions,
		request,
		currency,
	);
	if (!allocation) return null;
	return {
		total: formatMoney(allocation.total, currency),
		holdingsCount: allocation.holdingsCount,
		holdings: allocation.holdings.map((holding) => ({
			ticker: holding.ticker,
			weight: holding.weight,
			value: formatMoney(holding.value, currency, 0),
			change: holding.change,
			changeLabel:
				holding.change === null
					? "?"
					: formatMoneyChange(holding.change, "$", 2, currency),
			returnLabel:
				holding.returnPct === null
					? "?"
					: formatMoneyChange(holding.returnPct, "%", 1),
		})),
	};
}

export async function renderPortfolioChart(chart: PortfolioChart) {
	return renderPortfolioAllocation(chart);
}
