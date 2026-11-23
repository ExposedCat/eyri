import {
  getAllIntegrations,
  type Integration,
} from "../../database/integration.ts";
import type { Database } from "../../database/setup.ts";
import { gatewayMonitor } from "./gateway.ts";
import { GATEWAY_RETRY_INTERVAL_MS, gatewayRecovery, getRestartContainerName } from "./recovery.ts";

// Let the controller finish its own recovery. A halted controller has stopped
// attempting login, so it can start a fresh attempt without an outage delay.
export class GatewayWatchdog {
  private unavailableSince = new Map<string, number>();
  private lastUnavailableAttempt = new Map<string, number>();
  constructor(
    private health = (host: string) => gatewayMonitor.read(host, true),
    private recover = (integration: Integration) =>
      gatewayRecovery.recover(integration),
    private now = Date.now,
  ) {}

  async check(integration: Integration) {
    const host = getRestartContainerName(integration.credentials);
    const health = await this.health(host);
    if (health.state !== "unavailable") {
      this.unavailableSince.delete(host);
      if (health.state !== "blocked") return;
    } else {
      const now = this.now();
      const since = this.unavailableSince.get(host) ?? now;
      this.unavailableSince.set(host, since);
      const lastAttempt = this.lastUnavailableAttempt.get(host);
      if (now - since < 120_000 ||
          (lastAttempt !== undefined && now - lastAttempt < GATEWAY_RETRY_INTERVAL_MS)) return;
      this.lastUnavailableAttempt.set(host, now);
    }
    const result = await this.recover(integration);
    if (result) console.warn(`IBKR watchdog ${host}: ${result}`);
  }
}

let timer: ReturnType<typeof setInterval> | undefined;
export function startGatewayWatchdog(database: Database) {
  if (timer !== undefined) return;
  const watchdog = new GatewayWatchdog();
  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    try {
      const integrations = getAllIntegrations(database).filter((item) =>
        item.kind === "ibkr"
      );
      const hosts = new Set<string>();
      await Promise.all(integrations.map(async (integration) => {
        try {
          const host = getRestartContainerName(integration.credentials);
          if (hosts.has(host)) return;
          hosts.add(host);
          await watchdog.check(integration);
        } catch (error) {
          console.error("IBKR watchdog failed:", error);
        }
      }));
    } catch (error) {
      console.error("IBKR watchdog failed:", error);
    } finally {
      running = false;
    }
  };
  timer = setInterval(run, 30_000);
  run();
}
