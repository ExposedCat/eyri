import { deepStrictEqual, equal, ok, rejects, throws } from "node:assert/strict";
import { fetchConversionRates, fetchHistoricalUsdConversionRates, fetchUsdConversionRates, historicalUsdFactor } from "./exchange_rates.ts";

Deno.test("historical funding FX uses the last available date, never a future or stale rate", async () => {
  const rates = await fetchHistoricalUsdConversionRates(["CZK", "GBP", "GBX", "USD"], "2026-01-03", "2026-01-05", async input => {
    const url = new URL(String(input));
    equal(url.searchParams.get("from"), "2025-12-27");
    equal(url.searchParams.get("to"), "2026-01-05");
    equal(url.searchParams.get("quotes"), "czk,gbp");
    return Response.json([
      { base: "USD", quote: "CZK", date: "2026-01-05", rate: 25 },
      { base: "USD", quote: "CZK", date: "2026-01-02", rate: 20 },
      { base: "USD", quote: "GBP", date: "2026-01-02", rate: .5 },
    ]);
  });
  equal(historicalUsdFactor(rates, "CZK", "2026-01-03"), .05);
  equal(historicalUsdFactor(rates, "CZK", "2026-01-05"), .04);
  equal(historicalUsdFactor(rates, "GBX", "2026-01-03"), .02);
  equal(historicalUsdFactor(rates, "USD", "1900-01-01"), 1);
  throws(() => historicalUsdFactor(rates, "CZK", "2026-01-01"), /unavailable/);
  throws(() => historicalUsdFactor(rates, "CZK", "2026-01-13"), /unavailable/);
  deepStrictEqual(await fetchHistoricalUsdConversionRates(["USD"], "2026-01-03", "2026-01-05", () => { throw new Error("Unexpected request"); }), new Map());
});

Deno.test("historical funding FX rejects malformed, missing, duplicate or mismatched currency data", async () => {
  const row = { base: "USD", quote: "CZK", date: "2026-01-02", rate: 20 };
  for (const data of [{}, [], [row, row], [{ ...row, rate: 0 }], [{ ...row, quote: "EUR" }], [{ ...row, date: "2026-01-06" }]]) {
    await rejects(fetchHistoricalUsdConversionRates(["CZK"], "2026-01-03", "2026-01-05", async () => Response.json(data)), /historical exchange rates/i);
  }
  await rejects(fetchHistoricalUsdConversionRates(["CZK"], "2026-01-03", "2026-01-05", async () => new Response(null, { status: 503 })), /HTTP 503/);
});

Deno.test("report conversion handles cross rates and pence as source or target", async () => {
  const request: typeof fetch = async (input) => {
    const quote = String(input).split("/").at(-1)!.toUpperCase();
    return Response.json({ base: "USD", quote, rate: quote === "EUR" ? .8 : .5 });
  };
  deepStrictEqual(await fetchConversionRates(["USD", "EUR", "GBP", "GBX"], "EUR", request),
    new Map([["USD", .8], ["EUR", 1], ["GBP", 1.6], ["GBX", .016]]));
  deepStrictEqual(await fetchConversionRates(["USD", "GBP", "GBX"], "GBX", request),
    new Map([["USD", 50], ["GBP", 100], ["GBX", 1]]));
  await rejects(fetchConversionRates(["USD"], "EUR", async () => new Response(null, { status: 503 })), /EUR/);
});

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
