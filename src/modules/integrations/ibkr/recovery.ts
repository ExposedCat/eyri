import type { Integration } from "../../database/integration.ts";
import { getIbkrHostPort } from "./credentials.ts";
import { GatewayError, type GatewayHealth, gatewayMonitor } from "./gateway.ts";
import { UserFacingError } from "../../../utils/user_error.ts";
import { ibkrSessions } from "./session.ts";
import { probeIbkrApi } from "./adapter.ts";

const DEFAULT_PODMAN_SOCKET_PATH = "/run/podman/podman.sock";
const RESTART_FOLLOW_TIMEOUT_MS = 10 * 60_000;
const READINESS_POLL_MS = 2_000;
const CONNECTION_RETRY_INTERVAL_MS = 3 * 60_000;
export const GATEWAY_RETRY_INTERVAL_MS = 15 * 60_000;

type AutomaticAttempt = { at: number; halted: boolean; failure?: unknown };

type GatewayProgress = (message: string, ready?: boolean) => void;

export type ReportGatewayRecovery = {
  userId: number;
  onProgress: (host: string, message: string) => void;
};

type RestartFollow = {
  message: string;
  ready?: boolean;
  listeners: Set<GatewayProgress>;
  completion: Promise<void>;
};

function restartProgressMessage(health: GatewayHealth) {
  if (health.state === "ready") return "Connecting to IBKR…";
  switch (health.reason) {
    case "starting": return "IB Gateway is starting up…";
    case "login": return "Signing in to IBKR…";
    case "verification":
      return "Waiting for 2FA approval. If IBKR sends a prompt, approve it in the app.";
    case "login_paused":
      return "IBKR has paused sign-in. I’ll keep checking.";
    case "reconnecting": return "Reconnecting to IBKR…";
    case "api_starting": return "Connecting to IBKR…";
  }
}

function getPodmanSocketPath() {
  return Deno.env.get("PODMAN_SOCKET_PATH") ?? DEFAULT_PODMAN_SOCKET_PATH;
}

export function getRestartContainerName(credentials: Record<string, unknown>) {
  const instanceUrl = credentials.instanceUrl;
  if (typeof instanceUrl !== "string" || instanceUrl.trim().length === 0) {
    throw new Error(
      "IBKR integration does not have an instance URL configured",
    );
  }

  return getIbkrHostPort(instanceUrl).host;
}

function encodePodmanPathSegment(value: string) {
  return encodeURIComponent(value);
}

function parseHttpStatus(response: string) {
  const statusLine = response.split("\r\n", 1)[0];
  const match = /^HTTP\/\d(?:\.\d)?\s+(\d+)/.exec(statusLine);
  if (!match) {
    throw new Error("Podman returned an invalid HTTP response");
  }

  return Number(match[1]);
}

function parseHttpBody(response: string) {
  const separatorIndex = response.indexOf("\r\n\r\n");
  if (separatorIndex === -1) {
    return "";
  }

  return response.slice(separatorIndex + 4).trim();
}

async function readConnection(conn: Deno.Conn) {
  const chunks: Uint8Array[] = [];
  const buffer = new Uint8Array(8_192);

  while (true) {
    const bytesRead = await conn.read(buffer);
    if (bytesRead === null) {
      break;
    }

    chunks.push(buffer.slice(0, bytesRead));
  }

  const size = chunks.reduce((total, chunk) => total + chunk.length, 0);
  const output = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }

  return new TextDecoder().decode(output);
}

export async function restartGatewayContainer(containerName: string, onRequested?: () => void) {
  const socketPath = getPodmanSocketPath();
  const path = `/containers/${
    encodePodmanPathSegment(containerName)
  }/restart?t=90`;
  const request = [
    `POST ${path} HTTP/1.1`,
    "Host: podman",
    "Content-Length: 0",
    "Connection: close",
    "",
    "",
  ].join("\r\n");

  let conn: Deno.Conn;
  try {
    conn = await Deno.connect({
      transport: "unix",
      path: socketPath,
    });
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      throw new Error(
        `Podman socket not found at ${socketPath}. Start the host user socket with "systemctl --user enable --now podman.socket" and mount it into the app container.`,
      );
    }

    if (error instanceof Deno.errors.PermissionDenied) {
      throw new Error(
        `Podman socket at ${socketPath} is not accessible from the app container. Mount the host socket read-write and disable SELinux container labeling for this service.`,
      );
    }

    throw error;
  }

  // Explicit API timeout: older podman-compose releases can leave the
  // container's default stop timeout at 10s despite stop_grace_period.
  const deadline = setTimeout(() => {
    try {
      conn.close();
    } catch { /* already closed */ }
  }, 100_000);
  try {
    const bytes = new TextEncoder().encode(request);
    let offset = 0;
    while (offset < bytes.length) {
      offset += await conn.write(bytes.subarray(offset));
    }
    onRequested?.();
    const response = await readConnection(conn);
    const status = parseHttpStatus(response);
    if (status >= 200 && status < 300) {
      return;
    }

    const body = parseHttpBody(response);
    throw new Error(
      body
        ? `Podman returned ${status}: ${body.slice(0, 500)}`
        : `Podman returned ${status}`,
    );
  } finally {
    clearTimeout(deadline);
    try {
      conn.close();
    } catch { /* deadline already closed it */ }
  }
}

export class GatewayRecovery {
  private pending = new Map<string, Promise<string | undefined>>();
  private pendingRestarts = new Map<string, Promise<string>>();
  private followingRestarts = new Map<string, RestartFollow>();
  private restartRequested = new Map<string, Promise<void>>();
  private automaticAttempts = new Map<string, AutomaticAttempt>();
  constructor(
    private health = (host: string) => gatewayMonitor.read(host, true),
    private probe = probeIbkrApi,
    private restartContainer = restartGatewayContainer,
    private reset = (host: string) => {
      ibkrSessions.reset(host);
      gatewayMonitor.invalidate(host);
    },
    private now = Date.now,
    private sleep = (ms: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, ms)),
  ) {}

  private confirmConnection(host: string) {
    this.automaticAttempts.delete(host);
    ibkrSessions.resume(host);
    gatewayMonitor.invalidate(host);
  }

  restart(integration: Integration): Promise<string> {
    const host = getRestartContainerName(integration.credentials);
    const pending = this.pendingRestarts.get(host);
    if (pending) return pending;
    let requested!: () => void, failed!: (error: unknown) => void;
    const started = new Promise<void>((resolve, reject) => { requested = resolve; failed = reject; });
    // Manual callers only await completion; do not create an unhandled rejection.
    void started.catch(() => {});
    this.restartRequested.set(host, started);
    const request = (async () => {
      try {
        this.reset(host);
        await this.restartContainer(host, requested);
        requested();
      } catch (error) {
        failed(error);
        throw error;
      }
      return `${host}: restarted.`;
    })().finally(() => { this.pendingRestarts.delete(host); this.restartRequested.delete(host); });
    this.pendingRestarts.set(host, request);
    return request;
  }

  restartAndFollow(integration: Integration, onProgress: GatewayProgress): Promise<void> {
    return this.followGateway(integration, onProgress);
  }

  private followGateway(integration: Integration, onProgress: GatewayProgress, health?: GatewayHealth): Promise<void> {
    const host = getRestartContainerName(integration.credentials);
    const active = this.followingRestarts.get(host);
    if (active) {
      active.listeners.add(onProgress);
      onProgress(active.message, active.ready);
      return active.completion;
    }

    const pending = this.pendingRestarts.get(host);
    const follow: RestartFollow = {
      message: health
        ? restartProgressMessage(health) ?? "Waiting for IB Gateway to come back…"
        : "Restarting IB Gateway…",
      listeners: new Set([onProgress]),
      completion: Promise.resolve().then(async () => {
        try {
          if (pending) await pending;
          else if (!health) await this.restart(integration);
        } catch (cause) {
          throw new UserFacingError(
            "I couldn’t restart IB Gateway. Ask the bot admin to check it.",
            { cause, code: "ibkr_restart_failed" },
          );
        }
        const result = await this.waitForReadiness(
          integration,
          host,
          RESTART_FOLLOW_TIMEOUT_MS,
          (health) => {
            const message = restartProgressMessage(health);
            if (message) publish(message);
          },
        );
        if (result.outcome === "ready") {
          publish("IB Gateway is ready.", true);
        } else if (result.outcome === "blocked") {
          throw new UserFacingError("IB Gateway stopped trying to sign in. Eyri will try again automatically.", {
            code: "ibkr_login_halted",
          });
        } else {
          throw new UserFacingError(result.health.reason === "verification"
            ? "I stopped checking after 10 minutes. IB Gateway was still waiting for 2FA approval."
            : "IB Gateway still wasn’t ready after 10 minutes. Ask the bot admin to check its status.");
        }
      }).finally(() => this.followingRestarts.delete(host)),
    };
    const publish = (message: string, ready?: boolean) => {
      if (follow.message === message) return;
      follow.message = message;
      follow.ready = ready;
      for (const listener of follow.listeners) listener(message, ready);
    };
    this.followingRestarts.set(host, follow);
    onProgress(follow.message);
    return follow.completion;
  }

  private async followReport(integration: Integration, onProgress: GatewayProgress, health?: GatewayHealth) {
    try {
      await this.followGateway(integration, onProgress, health);
      return "retry" as const;
    } catch (error) {
      if (error instanceof UserFacingError) return error;
      throw error;
    }
  }

  async handleFailure(integration: Integration, error: unknown, report?: ReportGatewayRecovery): Promise<UserFacingError | "retry" | null> {
    const message = error instanceof Error ? error.message : String(error);
    if (!(error instanceof GatewayError) && !(error instanceof UserFacingError && error.code === "ibkr_connection") &&
      !/IBKR.*(?:disconnect|connection.*reset|auth.*expir|session.*expir)|(?:connecting to|waiting for) IBKR|ECONNREFUSED|ECONNRESET|EHOSTUNREACH/i.test(message)) return null;
    const host = getRestartContainerName(integration.credentials);
    const onProgress: GatewayProgress | undefined = report?.userId === integration.userId
      ? (message, ready) => { if (!ready) report.onProgress(host, message); }
      : undefined;
    if (onProgress && (this.pendingRestarts.has(host) || this.followingRestarts.has(host))) {
      return await this.followReport(integration, onProgress);
    }
    if (this.pendingRestarts.has(host)) {
      try { await this.restartRequested.get(host); }
      catch (cause) { return new UserFacingError("Gateway restart failed. Ask admin to check /status.", { cause }); }
      return new UserFacingError("Gateway is restarting. Please wait.");
    }
    const follow = this.followingRestarts.get(host);
    if (follow) return new UserFacingError(follow.message, { cause: error });
    let health = await this.health(host);
    if (health.state === "recovering") {
      if (!onProgress) return new UserFacingError(health.message, { cause: error });
      const result = await this.followReport(integration, onProgress, health);
      if (result === "retry" || result.code !== "ibkr_login_halted") return result;
      health = await this.health(host);
      if (health.state !== "blocked") return result;
    }
    const halted = health.state === "blocked";
    // Controller HTTP failures alone are not a reason to restart a working API.
    let apiReady = false;
    if (!halted) {
      try {
        await this.probe(integration);
        apiReady = true;
      } catch { /* Both the user request and independent API probe failed. */ }
    }
    if (onProgress && (this.pendingRestarts.has(host) || this.followingRestarts.has(host))) {
      return await this.followReport(integration, onProgress);
    }
    if (this.pendingRestarts.has(host)) {
      try { await this.restartRequested.get(host); }
      catch (cause) { return new UserFacingError("Gateway restart failed. Ask admin to check /status.", { cause }); }
      return new UserFacingError("Gateway is restarting. Please wait.", { cause: error });
    }
    const active = this.followingRestarts.get(host);
    if (active) return new UserFacingError(active.message, { cause: error });
    if (apiReady) {
      this.confirmConnection(host);
      return "retry";
    }
    const previous = this.automaticAttempts.get(host);
    const interval = halted || previous?.halted ? GATEWAY_RETRY_INTERVAL_MS : CONNECTION_RETRY_INTERVAL_MS;
    if (previous && this.now() - previous.at < interval) {
      if (previous.failure) return new UserFacingError("Gateway restart failed. Ask admin to check /status.");
      if (halted) return new UserFacingError("IBKR login stopped again. Eyri will retry automatically.");
      if (onProgress) return await this.followReport(integration, onProgress, health);
      return new UserFacingError("IBKR API is still unreachable. Retry shortly.");
    }
    const attempt: AutomaticAttempt = { at: this.now(), halted };
    this.automaticAttempts.set(host, attempt);
    if (onProgress) {
      const result = await this.followReport(integration, onProgress);
      if (result instanceof UserFacingError && result.code === "ibkr_restart_failed") attempt.failure = result;
      return result;
    }
    const completion = this.restart(integration);
    void completion.catch(cause => { attempt.failure = cause; console.error(`Gateway restart failed for ${host}:`, cause); });
    try { await this.restartRequested.get(host); }
    catch (cause) {
      attempt.failure = cause;
      return new UserFacingError("Gateway restart failed. Ask admin to check /status.", { cause });
    }
    const reason = /auth.*expir|session.*expir/i.test(message) ? "IBKR session expired."
      : halted ? "IBKR login stopped." : "IBKR API is unreachable.";
    return new UserFacingError(`${reason} Gateway restart requested; please wait.`);
  }

  recover(integration: Integration): Promise<string | undefined> {
    const host = getRestartContainerName(integration.credentials);
    const pending = this.pending.get(host);
    if (pending) return pending;
    const request = this.run(integration, host).finally(() =>
      this.pending.delete(host)
    );
    this.pending.set(host, request);
    return request;
  }

  private async run(integration: Integration, host: string) {
    const health = await this.health(host);
    if (health.state === "recovering") {
      return `${host}: ${health.message}`;
    }
    const halted = health.state === "blocked";
    if (!halted) {
      try {
        await this.probe(integration);
        return `${host}: API is ready; restart was unnecessary.`;
      } catch { /* The API failed even if the container looks ready. */ }
    }
    const follow = this.followingRestarts.get(host);
    if (follow) return `${host}: ${follow.message}`;
    if (this.pendingRestarts.has(host)) return;
    const previous = this.automaticAttempts.get(host);
    if (previous && (halted || previous.halted) && this.now() - previous.at < GATEWAY_RETRY_INTERVAL_MS) return;
    const attempt: AutomaticAttempt = { at: this.now(), halted };
    this.automaticAttempts.set(host, attempt);
    try {
      await this.restart(integration);
    } catch (cause) {
      attempt.failure = cause;
      throw cause;
    }
    const result = await this.waitForReadiness(integration, host, 180_000);
    if (result.outcome === "blocked") return `${host}: ${result.health.message}`;
    if (result.outcome === "ready") return `${host}: API readiness confirmed.`;
    return `${host}: restart completed, but API readiness is still unconfirmed. Login may need approval. The bot admin can check /status; avoid repeating the restart.`;
  }

  private async waitForReadiness(
    integration: Integration,
    host: string,
    timeoutMs: number,
    onHealth?: (health: GatewayHealth) => void,
  ) {
    const deadline = this.now() + timeoutMs;
    while (true) {
      const health = await this.health(host);
      if (health.state === "blocked") return { outcome: "blocked", health } as const;
      onHealth?.(health);
      if (
        health.state === "ready" || health.state === "unknown" ||
        health.state === "unavailable"
      ) {
        try {
          await this.probe(integration);
          this.confirmConnection(host);
          return { outcome: "ready", health } as const;
        } catch { /* Login can take several minutes, keep checking. */ }
      }
      const remaining = deadline - this.now();
      if (remaining <= 0) return { outcome: "timeout", health } as const;
      await this.sleep(Math.min(remaining, READINESS_POLL_MS));
    }
  }
}

export const gatewayRecovery = new GatewayRecovery();

export async function retryIbkrReport<T>(
  integration: Integration,
  error: unknown,
  request: () => Promise<T>,
  report?: ReportGatewayRecovery,
): Promise<T> {
  const recovery = await gatewayRecovery.handleFailure(integration, error, report).catch((cause) => {
    console.error("Gateway recovery could not be requested:", cause);
    return null;
  });
  if (recovery === "retry") return await request();
  throw recovery ?? error;
}
