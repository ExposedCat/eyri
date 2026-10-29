export type ReportKind = "perf" | "alltime" | "worth" | "dpnl";
export type ReportFilter = "stocks" | "options" | null;

export function parseReportArgs(input: unknown, defaultKind: ReportKind, daily = false) {
  const parts = typeof input === "string" ? input.trim().split(/\s+/).filter(Boolean) : [];
  const first = parts[0]?.toLowerCase();
  let kind = defaultKind;
  if (["perf", "alltime", "worth", "dpnl"].includes(first)) {
    if (first === "dpnl" && !daily) return null;
    kind = parts.shift()!.toLowerCase() as ReportKind;
  }
  const args = parsePerformanceArgs(parts.join(" "));
  if (args?.filter && args.bucketName && ["s", "o", "stocks", "options"].includes(args.bucketName.toLowerCase())) return null;
  return args ? { kind, ...args } : null;
}

export function parsePerformanceArgs(input: unknown) {
  const parts = typeof input === "string" ? input.trim().split(/\s+/).filter(Boolean) : [];
  const first = parts[0]?.toLowerCase();
  const filter: ReportFilter = first === "s" || first === "stocks"
    ? "stocks"
    : first === "o" || first === "options" ? "options" : null;
  if (filter) parts.shift();
  if (parts.length > 1) return null;
  return { filter, bucketName: parts[0] ?? null };
}
