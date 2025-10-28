export function formatMoneyChange(
	change: number,
	kind: "%" | "$" = "$",
	points = 2,
) {
	return `${change > 0 ? "+" : "-"}${kind === "$" ? "$" : ""}${Math.abs(change).toFixed(points)}${kind === "%" ? "%" : ""}`;
}
