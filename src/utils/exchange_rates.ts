import { logFetch } from "./fetch_logging.ts";

// Historical factors are for the amount that could actually have been invested
// on a funding date. Current reporting factors must not replace these.
export async function fetchHistoricalUsdConversionRates(
	currencies: string[],
	start: string,
	end: string,
	request: typeof fetch = fetch,
): Promise<Map<string, { date: string; factor: number }[]>> {
	const codes = [...new Set(currencies.map(code => code.trim().toUpperCase()))]
		.filter(code => code !== "USD");
	if (!codes.length) return new Map();
	const quotes = [...new Set(codes.map(code => code === "GBX" ? "GBP" : code))];
	const from = new Date(Date.parse(start) - 7 * 86_400_000).toISOString().slice(0, 10);
	const url = new URL("https://api.frankfurter.dev/v2/rates");
	url.search = new URLSearchParams({ base: "usd", quotes: quotes.join(",").toLowerCase(), from, to: end }).toString();
	return await logFetch(`Historical USD exchange rates (${quotes.join(", ")})`, async () => {
		const response = await request(url, { signal: AbortSignal.timeout(10_000) });
		if (!response.ok) {
			await response.body?.cancel();
			throw new Error(`Historical exchange rates unavailable: HTTP ${response.status}`);
		}
		const data: unknown = await response.json();
		if (!Array.isArray(data)) throw new Error("Invalid historical exchange rates");
		const result = new Map(codes.map(code => [code, [] as { date: string; factor: number }[]]));
		for (const row of data) {
			if (row?.base !== "USD" || !quotes.includes(row?.quote) ||
				!/^\d{4}-\d{2}-\d{2}$/.test(row?.date) ||
				!Number.isFinite(Date.parse(row.date)) || row.date < from || row.date > end ||
				typeof row.rate !== "number" || !Number.isFinite(row.rate) || row.rate <= 0 || !Number.isFinite(1 / row.rate)) {
				throw new Error("Invalid historical exchange rates");
			}
			for (const code of codes) {
				if ((code === "GBX" ? "GBP" : code) === row.quote) {
					result.get(code)!.push({ date: row.date, factor: 1 / row.rate / (code === "GBX" ? 100 : 1) });
				}
			}
		}
		for (const [code, rows] of result) {
			rows.sort((a, b) => a.date.localeCompare(b.date));
			if (!rows.length || rows.some((row, index) => index > 0 && row.date === rows[index - 1].date)) {
				throw new Error(`Historical exchange rates unavailable for ${code}`);
			}
		}
		return result;
	});
}

export function historicalUsdFactor(
	rates: ReadonlyMap<string, { date: string; factor: number }[]>,
	currency: string,
	date: string,
): number {
	if (currency === "USD") return 1;
	const rows = rates.get(currency) ?? [];
	const row = rows.findLast(row => row.date <= date);
	if (!row || Date.parse(date) - Date.parse(row.date) > 7 * 86_400_000) {
		throw new Error(`Historical USD exchange rate unavailable for ${currency} on ${date}`);
	}
	return row.factor;
}

// Returned factors convert native amounts to the requested reporting currency.
export async function fetchConversionRates(
	currencies: string[],
	currency = "USD",
	request: typeof fetch = fetch,
): Promise<Map<string, number>> {
	if (!currencies.length) return new Map();
	const target = currency.trim().toUpperCase();
	const rates = await fetchUsdConversionRates([...currencies, target], request);
	const targetRate = rates.get(target)!;
	return new Map(currencies.map((source) => {
		const code = source.trim().toUpperCase();
		const factor = rates.get(code)! / targetRate;
		if (!Number.isFinite(factor) || factor <= 0) {
			throw new Error(`Conversion unavailable for ${code} to ${target}.`);
		}
		return [code, factor];
	}));
}

// Returned factors convert one unit of each requested currency into USD.
export async function fetchUsdConversionRates(
	currencies: string[],
	request: typeof fetch = fetch,
): Promise<Map<string, number>> {
	const normalized = [
		...new Set(currencies.map((currency) => currency.trim().toUpperCase())),
	];
	const quotes = [
		...new Set(
			normalized.map((currency) => currency === "GBX" ? "GBP" : currency),
		),
	].filter((currency) => currency !== "USD");
	const rates = new Map<string, number>([["USD", 1]]);
	await Promise.all(quotes.map((currency) =>
		logFetch(`Frankfurter USD/${currency} exchange rate`, async () => {
			try {
				const response = await request(
					`https://api.frankfurter.dev/v2/rate/usd/${
						encodeURIComponent(currency.toLowerCase())
					}`,
					{ signal: AbortSignal.timeout(10_000) },
				);
				if (!response.ok) {
					await response.body?.cancel();
					throw new Error(`HTTP ${response.status}`);
				}
				const data = await response.json();
				if (
					data?.base !== "USD" || data?.quote !== currency ||
					typeof data.rate !== "number" || !Number.isFinite(data.rate) ||
					data.rate <= 0 || !Number.isFinite(1 / data.rate)
				) {
					throw new Error("Invalid exchange rate");
				}
				// The endpoint reports quote units per USD, so invert it.
				rates.set(currency, 1 / data.rate);
			} catch (error) {
				throw new Error(`Could not load USD exchange rate for ${currency}.`, {
					cause: error,
				});
			}
		})
	));
	return new Map(normalized.map((currency) => [
		currency,
		currency === "GBX" ? rates.get("GBP")! / 100 : rates.get(currency)!,
	]));
}
