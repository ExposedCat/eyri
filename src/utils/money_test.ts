import { equal } from "node:assert/strict";
import { formatMoney, formatMoneyChange } from "./money.ts";

Deno.test("money groups thousands and preserves decimals and signs", () => {
	equal(formatMoney(10000.11), "$10,000.11");
	equal(formatMoney(-10000.11), "-$10,000.11");
	equal(formatMoney(10000.11, "EUR"), "10,000.11 EUR");
	equal(formatMoney(10000.6, "USD", 0), "$10,001");
	equal(formatMoneyChange(10000.11), "+$10,000.11");
	equal(formatMoneyChange(-10000.11), "-$10,000.11");
	equal(formatMoneyChange(-0.001), "$0.00");
	equal(formatMoneyChange(0, "%"), "0.00%");
	equal(formatMoneyChange(12.345, "%"), "+12.35%");
});
