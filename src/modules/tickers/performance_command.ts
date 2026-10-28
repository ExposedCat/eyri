export function parsePerformanceArgs(input: unknown) {
  const parts = typeof input === "string" ? input.trim().split(/\s+/).filter(Boolean) : [];
  const first = parts[0]?.toLowerCase();
  const filter = first === "s" || first === "stocks"
    ? "stocks"
    : first === "o" || first === "options" ? "options" : null;
  if (filter) parts.shift();
  if (parts.length > 1) return null;
  return { filter, bucketName: parts[0] ?? null };
}
