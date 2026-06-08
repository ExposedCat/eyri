export type IbkrCredentials = {
  instanceUrl: string;
  accountId?: string;
  clientId: number;
  timeoutMs: number;
  flexToken?: string;
  flexQueryId?: string;
};

const DEFAULT_CLIENT_ID = 0;
const DEFAULT_TIMEOUT_MS = 5_000;

function readString(
  credentials: Record<string, unknown>,
  name: string,
  required = false,
) {
  const value = credentials[name];
  if (typeof value !== "string" || value.trim().length === 0) {
    if (required) {
      throw new Error(`IBKR credential ${name} is required`);
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
    throw new Error(`IBKR credential ${name} must be a positive number`);
  }

  return parsed;
}

export function parseIbkrCredentials(
  credentials: Record<string, unknown>,
): IbkrCredentials {
  return {
    instanceUrl: readString(credentials, "instanceUrl", true) ?? "",
    accountId: readString(credentials, "accountId"),
    clientId: readNumber(credentials, "clientId", DEFAULT_CLIENT_ID),
    timeoutMs: readNumber(credentials, "timeoutMs", DEFAULT_TIMEOUT_MS),
    flexToken: readString(credentials, "flexToken"),
    flexQueryId: readString(credentials, "flexQueryId"),
  };
}

export function getIbkrHostPort(instanceUrl: string) {
  const url = new URL(
    instanceUrl.includes("://") ? instanceUrl : `tcp://${instanceUrl}`,
  );
  const port = Number(url.port || 4004);
  if (!url.hostname || !Number.isInteger(port) || port <= 0) {
    throw new Error("IBKR instance URL must include a host and valid port");
  }

  return { host: url.hostname, port };
}
