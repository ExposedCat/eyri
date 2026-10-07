let nextFetchId = 0;

export async function logFetch<T>(
  operation: string,
  request: () => Promise<T>,
  count?: (result: T) => number | undefined,
): Promise<T> {
  const label = `[fetch ${++nextFetchId}] ${operation}`;
  const startedAt = performance.now();
  console.log(`${label}: started`);
  try {
    const result = await request();
    const items =
      count?.(result) ??
      (Array.isArray(result)
        ? result.length
        : result instanceof Map
          ? result.size
          : undefined);
    const elapsed = Math.round(performance.now() - startedAt);
    console.log(
      `${label}: completed in ${elapsed}ms${items === undefined ? "" : ` (${items} items)`}`,
    );
    return result;
  } catch (error) {
    const elapsed = Math.round(performance.now() - startedAt);
    const reason = error instanceof Error ? error.name : "Unknown error";
    console.error(`${label}: failed after ${elapsed}ms (${reason})`);
    throw error;
  }
}
