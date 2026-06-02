import type { ServiceResult } from "../../utils/service.ts";

const API_URL = "https://stooq.com";
const STOOQ_FETCH_TIMEOUT_MS = 3000;

export async function fetchTickerPrice(
  ticker: string,
): Promise<ServiceResult<number | null>> {
  const controller = new AbortController();
  const timeoutId = setTimeout(
    () => controller.abort(),
    STOOQ_FETCH_TIMEOUT_MS,
  );

  try {
    const response = await fetch(`${API_URL}/q/l/?s=${ticker}`, {
      signal: controller.signal,
    });
    if (!response.ok) {
      return { success: false, error: "Failed to fetch ticker price" };
    }

    const data = await response.text();
    const price = data.split(",").at(6) ?? null;
    return { success: true, data: price ? Number(price) : null };
  } catch (error) {
    console.error(error);
    return { success: false, error: "Failed to fetch ticker price" };
  } finally {
    clearTimeout(timeoutId);
  }
}
