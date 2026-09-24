import type { RsuAward } from "../database/rsu.ts";
import { formatMoney, formatMoneyChange } from "../../utils/money.ts";

const DAY_MS = 86_400_000;

export function parseRsuDate(value: string) {
	const match = /^(\d{2})\.(\d{2})\.(\d{2}|\d{4})$/.exec(value);
	if (!match) throw new Error("Use DD.MM.YY for dates.");
	const day = Number(match[1]);
	const month = Number(match[2]);
	const year = Number(match[3]) + (match[3].length === 2 ? 2000 : 0);
	const date = new Date(Date.UTC(year, month - 1, day));
	if (
		date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 ||
		date.getUTCDate() !== day
	) {
		throw new Error(`Invalid date: ${value}`);
	}
	return date.toISOString().slice(0, 10);
}

function parsePositiveNumber(value: string) {
	const number = Number(value);
	if (
		!/^\d+(?:\.\d+)?$/.test(value) || !Number.isFinite(number) || number <= 0
	) {
		throw new Error("Amounts and award price must be positive numbers.");
	}
	return number;
}

export function parseRsuAward(input: string): RsuAward {
	const [header, ...lines] = input.trim().split(/\r?\n/).map((line) =>
		line.trim()
	).filter(Boolean);
	const parts = (header ?? "").split(/\s+/);
	if (parts.length !== 4 || lines.length === 0) {
		throw new Error(
			"Use /rsu TICKER AMOUNT PRICE DD.MM.YY followed by vesting lines: DD.MM.YY AMOUNT.",
		);
	}
	const ticker = parts[0].toUpperCase();
	if (!/^[A-Z][A-Z0-9.-]{0,19}$/.test(ticker)) {
		throw new Error("Invalid stock ticker.");
	}
	const amount = parsePositiveNumber(parts[1]);
	const price = parsePositiveNumber(parts[2]);
	const awardDate = parseRsuDate(parts[3]);
	const vesting = lines.map((line) => {
		const values = line.split(/\s+/);
		if (values.length !== 2) {
			throw new Error("Each vesting line must be DD.MM.YY AMOUNT.");
		}
		const date = parseRsuDate(values[0]);
		if (date < awardDate) {
			throw new Error("Vesting cannot be before the award date.");
		}
		return { date, amount: parsePositiveNumber(values[1]) };
	}).sort((first, second) => first.date.localeCompare(second.date));
	const total = vesting.reduce((sum, entry) => sum + entry.amount, 0);
	if (Math.abs(total - amount) > 1e-8 * Math.max(1, amount)) {
		throw new Error(
			`Vesting amounts must total the awarded amount (${amount}).`,
		);
	}
	if (!Number.isFinite(amount * price)) {
		throw new Error("Award value is too large.");
	}
	return { ticker, amount, price, awardDate, vesting };
}

export function formatRsuTimeLeft(date: string, now: Date) {
	const target = new Date(`${date}T00:00:00Z`);
	const today = now.toISOString().slice(0, 10);
	if (date === today) return "today";
	if (target.getTime() - now.getTime() < DAY_MS) return "less than 1D";
	return formatRsuDuration(today, date);
}

export function formatRsuDuration(start: string, end: string) {
	if (end <= start) return "0d";
	const today = new Date(`${start}T00:00:00Z`);
	const target = new Date(`${end}T00:00:00Z`);
	let months = (target.getUTCFullYear() - today.getUTCFullYear()) * 12 +
		target.getUTCMonth() - today.getUTCMonth();
	const shiftMonths = (count: number) => {
		const shifted = new Date(
			Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + count, 1),
		);
		const lastDay = new Date(
			Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth() + 1, 0),
		).getUTCDate();
		shifted.setUTCDate(Math.min(today.getUTCDate(), lastDay));
		return shifted;
	};
	if (shiftMonths(months) > target) months--;
	const days = Math.floor(
		(target.getTime() - shiftMonths(months).getTime()) / DAY_MS,
	);
	const years = Math.floor(months / 12);
	return years > 0
		? `${years}y ${months % 12}m ${days}d`
		: months > 0
		? `${months}m ${days}d`
		: `${days}d`;
}

type RsuVestingEntry = {
	date: string;
	amount: number;
	ticker: string;
	awardPrice: number;
};

export function getRsuView(awards: RsuAward[], now: Date, cutoff?: string) {
	const today = now.toISOString().slice(0, 10);
	const end = cutoff ?? today;
	const vestings = awards.flatMap((award) =>
		award.vesting.map((vesting) => ({
			...vesting,
			ticker: award.ticker,
			awardPrice: award.price,
		}))
	).sort((first, second) =>
		first.date.localeCompare(second.date) ||
		first.ticker.localeCompare(second.ticker)
	);
	return {
		upcoming: vestings.filter((vesting) =>
			vesting.date >= today && (!cutoff || vesting.date <= cutoff)
		),
		received: vestings.filter((vesting) => vesting.date <= end),
		missed: cutoff ? vestings.filter((vesting) => vesting.date > cutoff) : [],
		start: awards.map((award) => award.awardDate).sort()[0] ?? end,
		end,
		lastVesting: vestings.at(-1)?.date ?? end,
	};
}

function formatRsuValue(value: number | undefined, cost: number) {
	if (value === undefined) return "? (? ?)";
	const change = value - cost;
	const percentage = cost === 0 ? 0 : change / cost * 100;
	return `${formatMoney(value)} (${formatMoneyChange(change)} ${
		formatMoneyChange(percentage, "%")
	})`;
}

export function buildRsuSummary(
	label: "Total" | "Missed",
	vestings: RsuVestingEntry[],
	prices: Map<string, number>,
	start: string,
	end: string,
) {
	let value = 0;
	let cost = 0;
	let complete = true;
	for (const vesting of vestings) {
		const price = prices.get(vesting.ticker);
		if (price === undefined) complete = false;
		else value += vesting.amount * price;
		cost += vesting.amount * vesting.awardPrice;
	}
	return `${label}: ${
		formatRsuValue(complete ? value : undefined, cost)
	} over ${formatRsuDuration(start, end)}`;
}

export function buildRsuGroups(
	vestings: RsuVestingEntry[],
	prices: Map<string, number>,
	formatTicker: (ticker: string) => string,
	now: Date,
) {
	const dates = new Map<
		string,
		Map<string, { amount: number; cost: number }>
	>();
	for (const vesting of vestings) {
		const tickers = dates.get(vesting.date) ?? new Map();
		const current = tickers.get(vesting.ticker) ?? { amount: 0, cost: 0 };
		current.amount += vesting.amount;
		current.cost += vesting.amount * vesting.awardPrice;
		tickers.set(vesting.ticker, current);
		dates.set(vesting.date, tickers);
	}
	return [...dates].map(([date, tickers]) => {
		const lines = [...tickers].map(([ticker, { amount, cost }]) => {
			const price = prices.get(ticker);
			const name = formatTicker(ticker);
			return `${name} ${
				formatRsuValue(price === undefined ? undefined : amount * price, cost)
			}`;
		});
		return `${date.split("-").reverse().join(".")} (${
			formatRsuTimeLeft(date, now)
		})\n${lines.join("\n")}`;
	});
}
