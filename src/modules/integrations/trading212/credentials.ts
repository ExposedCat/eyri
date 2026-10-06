export type Trading212Credentials = {
  apiKey: string;
  secretKey: string;
  environment: "live" | "demo";
};

export function parseTrading212Credentials(
  credentials: Record<string, unknown>,
): Trading212Credentials {
  const { apiKey, secretKey, environment = "live" } = credentials;
  if (typeof apiKey !== "string" || !apiKey.trim()) {
    throw new Error("Trading 212 API key is required");
  }
  if (typeof secretKey !== "string" || !secretKey.trim()) {
    throw new Error("Trading 212 API secret is required");
  }
  if (environment !== "live" && environment !== "demo") {
    throw new Error("Trading 212 environment must be live or demo");
  }
  return { apiKey: apiKey.trim(), secretKey: secretKey.trim(), environment };
}
