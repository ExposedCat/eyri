import { deepStrictEqual, equal, ok, rejects } from "node:assert/strict";
import { fetchUsdConversionRates } from "./exchange_rates.ts";

Deno.test("USD conversion needs no exchange-rate request", async () => {
	const noFetch: typeof fetch = () => {
		throw new Error("Unexpected request");
	};
	deepStrictEqual(await fetchUsdConversionRates([], noFetch), new Map());
	deepStrictEqual(
		await fetchUsdConversionRates(["usd", " USD "], noFetch),
		new Map([["USD", 1]]),
	);
});

Deno.test("USD pair rates are inverted and GBP and GBX share one request", async () => {
	const calls: string[] = [];
	const rates = await fetchUsdConversionRates(
		["USD", "eur", "EUR", "gbx", " GBP "],
		async (input, init) => {
			calls.push(String(input));
			ok(init?.signal);
			const quote = String(input).endsWith("gbp") ? "GBP" : "EUR";
			return Response.json({
				date: "2026-10-06",
				base: "USD",
				quote,
				rate: quote === "GBP" ? .5 : .8,
			});
		},
	);
	deepStrictEqual(calls.sort(), [
		"https://api.frankfurter.dev/v2/rate/usd/eur",
		"https://api.frankfurter.dev/v2/rate/usd/gbp",
	]);
	equal(rates.get("USD"), 1);
	equal(rates.get("EUR"), 1.25);
	equal(rates.get("GBP"), 2);
	equal(rates.get("GBX"), .02);
});

Deno.test("missing, invalid and mismatched rates fail instead of inventing conversion", async () => {
	for (
		const data of [
			null,
			{},
			...[0, -1, null, "0.8", 1e-320].map((rate) => ({
				base: "USD",
				quote: "EUR",
				rate,
			})),
			{ base: "EUR", quote: "USD", rate: .8 },
			{ base: "USD", quote: "GBP", rate: .8 },
		]
	) {
		await rejects(
			fetchUsdConversionRates(["EUR"], async () => Response.json(data)),
			/Could not load USD exchange rate for EUR/,
		);
	}
});

Deno.test("HTTP, network and malformed-response failures report the required currency", async () => {
	const failures: (typeof fetch)[] = [
		async () => new Response("Unavailable", { status: 503 }),
		async () => new Response("not json"),
		() => Promise.reject(new Error("Network unavailable")),
	];
	for (const request of failures) {
		await rejects(
			fetchUsdConversionRates(["GBX"], request),
			/Could not load USD exchange rate for GBP/,
		);
	}
});
