import {
  getAllIntegrations,
  type Integration,
} from "../../database/integration.ts";
import type { Database } from "../../database/setup.ts";
import { gatewayMonitor } from "./gateway.ts";
import { gatewayRecovery, getRestartContainerName } from "./recovery.ts";

// The controller already recovers JVM/upstream failures. Only restart a
// controller that remains unreachable; never interrupt its own recovery or
// turn a deliberate authentication halt into a fresh-login loop.
export class GatewayWatchdog {
  private unavailableSince = new Map<string, number>();
  private lastAttempt = new Map<string, number>();
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
      return;
    }
    const since = this.unavailableSince.get(host) ?? this.now();
    this.unavailableSince.set(host, since);
    const lastAttempt = this.lastAttempt.get(host);
    if (
      this.now() - since < 120_000 ||
      (lastAttempt !== undefined && this.now() - lastAttempt < 15 * 60_000)
    ) return;
    this.lastAttempt.set(host, this.now());
    console.warn(`IBKR watchdog ${host}: ${await this.recover(integration)}`);
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
    } finally {
      running = false;
    }
  };
  timer = setInterval(run, 30_000);
  run();
}
