import { logFetch } from "./fetch_logging.ts";

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
