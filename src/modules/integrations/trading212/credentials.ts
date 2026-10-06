export type Trading212Credentials = {
  apiKey: string;
  secretKey: string;
};

export function parseTrading212Credentials(
  credentials: Record<string, unknown>,
): Trading212Credentials {
  const { apiKey, secretKey } = credentials;
  if (typeof apiKey !== "string" || !apiKey.trim()) {
    throw new Error("Trading 212 API key is required");
  }
  if (typeof secretKey !== "string" || !secretKey.trim()) {
    throw new Error("Trading 212 API secret is required");
  }
  return { apiKey: apiKey.trim(), secretKey: secretKey.trim() };
}
