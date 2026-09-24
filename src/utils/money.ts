export function formatMoney(value: number, currency = "USD", points = 2) {
	const amount = Math.abs(value).toLocaleString("en-US", {
		minimumFractionDigits: points,
		maximumFractionDigits: points,
	});
	const sign = value < 0 ? "-" : "";
	return currency === "USD"
		? `${sign}$${amount}`
		: `${sign}${amount} ${currency}`;
}

export function formatMoneyChange(
	change: number,
	kind: "%" | "$" = "$",
	points = 2,
) {
	const rounded = Number(change.toFixed(points));
	const sign = rounded > 0 ? "+" : rounded < 0 ? "-" : "";
	return `${sign}${
		kind === "$"
			? formatMoney(Math.abs(rounded), "USD", points)
			: `${Math.abs(rounded).toFixed(points)}%`
	}`;
}
