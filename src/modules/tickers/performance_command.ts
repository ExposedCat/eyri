export type ReportKind = "perf" | "alltime" | "worth" | "dpnl";
export type ReportFilter = "stocks" | "options" | null;
export type BoughtFilter =
  | { mode: "today" }
  | { mode: "last"; count: number };

const ASSET_TOKENS = new Set(["s", "o", "stocks", "options"]);

function parseAssetFilter(token: string): ReportFilter {
  const lower = token.toLowerCase();
  if (lower === "s" || lower === "stocks") return "stocks";
  if (lower === "o" || lower === "options") return "options";
  return null;
}

function isBoughtLikeToken(token: string) {
  return /^(?:b|bought)\d*$/i.test(token);
}

function parseBoughtFilter(token: string): BoughtFilter | null {
  const lower = token.toLowerCase();
  if (lower === "b" || lower === "bought") return { mode: "today" };
  const match = /^(?:b|bought)([1-9]\d*)$/.exec(lower);
  if (!match) return null;
  const count = Number(match[1]);
  return Number.isSafeInteger(count) ? { mode: "last", count } : null;
}

export function parseReportArgs(input: unknown, defaultKind: ReportKind, daily = false) {
  const parts = typeof input === "string" ? input.trim().split(/\s+/).filter(Boolean) : [];
  const first = parts[0]?.toLowerCase();
  let kind = defaultKind;
  if (["perf", "alltime", "worth", "dpnl"].includes(first)) {
    if (first === "dpnl" && !daily) return null;
    kind = parts.shift()!.toLowerCase() as ReportKind;
  }
  const args = parsePerformanceArgs(parts.join(" "), kind === "dpnl");
  if (!args) return null;
  return { kind, ...args };
}

export function parsePerformanceArgs(input: unknown, allowBought = false) {
  const parts = typeof input === "string" ? input.trim().split(/\s+/).filter(Boolean) : [];
  let filter: ReportFilter = null;
  let bought: BoughtFilter | null = null;
  while (parts.length > 0) {
    const token = parts[0];
    const asset = parseAssetFilter(token);
    if (asset) {
      if (filter) return null;
      filter = asset;
      parts.shift();
      continue;
    }
    if (allowBought && isBoughtLikeToken(token)) {
      const parsed = parseBoughtFilter(token);
      if (!parsed || bought) return null;
      bought = parsed;
      parts.shift();
      continue;
    }
    break;
  }
  if (parts.length > 1) return null;
  const bucketName = parts[0] ?? null;
  if (bucketName) {
    if (filter && ASSET_TOKENS.has(bucketName.toLowerCase())) return null;
    if (allowBought && isBoughtLikeToken(bucketName)) return null;
  }
  return bought ? { filter, bought, bucketName } : { filter, bucketName };
}
