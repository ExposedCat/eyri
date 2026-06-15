export type Freedom24Credentials = {
  apiKey: string;
  secretKey: string;
  historyYears: number;
};

const DEFAULT_HISTORY_YEARS = 10;

function readString(
  credentials: Record<string, unknown>,
  name: string,
  required = false,
) {
  const value = credentials[name];
  if (typeof value !== "string" || value.trim().length === 0) {
    if (required) {
      throw new Error(`Freedom24 credential ${name} is required`);
    }
    return undefined;
  }

  return value.trim();
}

function readNumber(
  credentials: Record<string, unknown>,
  name: string,
  fallback: number,
) {
  const value = credentials[name];
  if (value === undefined || value === null || value === "") {
    return fallback;
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Freedom24 credential ${name} must be a positive number`);
  }

  return parsed;
}

export function parseFreedom24Credentials(
  credentials: Record<string, unknown>,
): Freedom24Credentials {
  return {
    apiKey: readString(credentials, "apiKey", true) ?? "",
    secretKey: readString(credentials, "secretKey", true) ?? "",
    historyYears: readNumber(
      credentials,
      "historyYears",
      DEFAULT_HISTORY_YEARS,
    ),
  };
}
