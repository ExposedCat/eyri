import type { Integration } from "../database/integration.ts";

export function describeIntegration(integration: Integration) {
  if (integration.kind === "ibkr") {
    const url = String(integration.credentials.instanceUrl ?? "unknown");
    const account = integration.credentials.accountId;
    return `IBKR ${url}${account ? `, account ${account}` : ""}`;
  }
  const key = String(integration.credentials.apiKey ?? "");
  // Never render a complete API key, including unusually short keys.
  const masked =
    key.length > 8 ? `${key.slice(0, 4)}…${key.slice(-4)}` : "••••";
  return integration.kind === "t212"
    ? `Trading 212 ${masked}`
    : `Freedom24 ${masked}`;
}
