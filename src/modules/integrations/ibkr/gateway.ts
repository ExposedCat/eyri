export type GatewayHealth = {
  state: "ready" | "recovering" | "blocked" | "unavailable" | "unknown";
  message: string;
};

// Only configured controller endpoints are probed. Legacy IBC gateways have
// no HTTP health server; their socket failures are handled by the connection pool.
export class GatewayMonitor {
  private cache = new Map<
    string,
    { until: number; request: Promise<GatewayHealth> }
  >();
  constructor(
    private urlForHost: (host: string) => string | undefined,
    private request: typeof fetch = fetch,
    private now = Date.now,
  ) {}

  read(host: string, force = false): Promise<GatewayHealth> {
    const url = this.urlForHost(host);
    if (!url) {
      return Promise.resolve({
        state: "unknown",
        message: "Readiness will be checked through the IBKR API.",
      });
    }
    const cached = this.cache.get(host);
    if (!force && cached && cached.until > this.now()) return cached.request;
    const request = this.load(url);
    this.cache.set(host, { until: this.now() + 5_000, request });
    return request;
  }

  invalidate(host: string) {
    this.cache.delete(host);
  }

  private async load(url: string): Promise<GatewayHealth> {
    try {
      const response = await this.request(url, {
        signal: AbortSignal.timeout(1_000),
      });
      const health = await response.json();
      if (health.state === "HALTED") {
        return {
          state: "blocked",
          message:
            "IBKR login is halted. A session lockout or authentication problem needs attention. Clear the held session/authentication issue before restarting.",
        };
      }
      if (
        response.ok && health.status === "healthy" &&
        health.jvm_alive === true &&
        health.api_port_open === true && health.socat_port_open === true &&
        health.upstream_connected !== false
      ) {
        return { state: "ready", message: "IBKR Gateway is ready." };
      }
      return {
        state: "recovering",
        message:
          "IBKR Gateway is logging in or reconnecting. Recovery is in progress; another restart can interrupt it.",
      };
    } catch {
      return {
        state: "unavailable",
        message:
          "IBKR Gateway health endpoint is unavailable. The gateway may be starting or stopped.",
      };
    }
  }
}

export const gatewayMonitor = new GatewayMonitor((host) => {
  const setting = Deno.env.get("IBKR_GATEWAY_HEALTH_URLS");
  if (!setting) return undefined;
  const urls = JSON.parse(setting) as Record<string, string>;
  return urls[host];
});

export async function assertGatewayReady(host: string) {
  const health = await gatewayMonitor.read(host);
  if (health.state !== "ready" && health.state !== "unknown") {
    throw new Error(health.message);
  }
}
