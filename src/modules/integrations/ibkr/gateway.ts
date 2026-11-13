import { UserFacingError } from "../../../utils/user_error.ts";

export type GatewayHealth = {
  state: "ready" | "recovering" | "blocked" | "unavailable" | "unknown";
  message: string;
  reason?: "starting" | "login" | "verification" | "api_starting" | "reconnecting" | "login_paused" | "halted" | "health_unavailable" | "bad_health";
};

export class GatewayError extends UserFacingError {
  constructor(readonly host: string, readonly health: GatewayHealth) {
    super(health.message, { code: "gateway" });
    this.name = "GatewayError";
  }
}

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
      if (!health || typeof health.state !== "string") {
        return { state: "unavailable", reason: "bad_health", message: "Gateway status reply is unreadable. Ask admin." };
      }
      if (health.state === "HALTED") {
        return {
          state: "blocked",
          reason: "halted",
          message: "IBKR login stopped. Ask admin to check Gateway login.",
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
      if (health.ccp_backoff_seconds > 0) return { state: "recovering", reason: "login_paused",
        message: `IBKR login paused for ${Math.ceil(health.ccp_backoff_seconds)} seconds. Please wait.` };
      if (health.state === "TWO_FA") return { state: "recovering", reason: "verification",
        message: "IBKR verification pending. Complete Gateway login." };
      if (["INIT", "LAUNCHING", "AGENT_WAIT", "APP_DISCOVERY"].includes(health.state)) return {
        state: "recovering", reason: "starting", message: "Gateway is starting. Please wait." };
      if (health.state === "LOGIN") return { state: "recovering", reason: "login",
        message: "IBKR is logging in. Please wait." };
      if (health.state === "UPSTREAM_DOWN" || health.upstream_connected === false) return {
        state: "recovering", reason: "reconnecting", message: health.upstream_recovery_active === false
          ? "IBKR server connection is down. Please wait."
          : "IBKR is reconnecting. Please wait." };
      return { state: "recovering", reason: "api_starting", message: "IBKR API is starting. Please wait." };
    } catch {
      return {
        state: "unavailable",
        reason: "health_unavailable",
        message: "Gateway status endpoint is unreachable. Retry shortly.",
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

export async function assertGatewayReady(host: string, monitor: Pick<GatewayMonitor, "read"> = gatewayMonitor) {
  const health = await monitor.read(host);
  // An HTTP outage is not proof that the independently reachable socket API
  // is down. Let the normal API handshake establish that state.
  if (health.state !== "ready" && health.state !== "unknown" && health.state !== "unavailable") {
    throw new GatewayError(host, health);
  }
}
