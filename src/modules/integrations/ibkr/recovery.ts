import type { Integration } from "../../database/integration.ts";
import { getIbkrHostPort } from "./credentials.ts";
import { type GatewayHealth, gatewayMonitor } from "./gateway.ts";
import { ibkrSessions } from "./session.ts";
import { probeIbkrApi } from "./adapter.ts";

const DEFAULT_PODMAN_SOCKET_PATH = "/run/podman/podman.sock";

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

export async function restartGatewayContainer(containerName: string) {
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
  private pending = new Map<string, Promise<string>>();
  private attempts = new Map<string, number>();
  constructor(
    private health = (host: string) => gatewayMonitor.read(host, true),
    private probe = probeIbkrApi,
    private restart = restartGatewayContainer,
    private reset = (host: string) => {
      ibkrSessions.reset(host);
      gatewayMonitor.invalidate(host);
    },
    private now = Date.now,
    private sleep = (ms: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, ms)),
  ) {}

  recover(integration: Integration, force = false): Promise<string> {
    const host = getRestartContainerName(integration.credentials);
    const pending = this.pending.get(host);
    if (pending) return pending;
    const request = this.run(integration, host, force).finally(() =>
      this.pending.delete(host)
    );
    this.pending.set(host, request);
    return request;
  }

  private async run(integration: Integration, host: string, force: boolean) {
    const health = await this.health(host);
    if (!force && health.state === "blocked") {
      return `${host}: ${health.message} After resolving it, use /restart force to resume login.`;
    }
    if (!force && health.state === "recovering") {
      return `${host}: ${health.message}`;
    }
    if (
      !force &&
      (health.state === "ready" || health.state === "unknown" ||
        health.state === "unavailable")
    ) {
      try {
        await this.probe(integration);
        return `${host}: API is ready; restart was unnecessary.`;
      } catch { /* The API failed even if the container looks ready. */ }
    }
    const lastAttempt = this.attempts.get(host);
    if (lastAttempt !== undefined && this.now() - lastAttempt < 15 * 60_000) {
      return `${host}: a restart was already attempted recently. Wait 15 minutes between attempts. The bot admin can check /status.`;
    }
    this.attempts.set(host, this.now());
    this.reset(host);
    await this.restart(host);
    const deadline = this.now() + 180_000;
    let status: GatewayHealth = health;
    while (this.now() < deadline) {
      status = await this.health(host);
      if (status.state === "blocked") return `${host}: ${status.message}`;
      if (
        status.state === "ready" || status.state === "unknown" ||
        status.state === "unavailable"
      ) {
        try {
          await this.probe(integration);
          return `${host}: API readiness confirmed.`;
        } catch { /* Login can take several minutes, keep checking. */ }
      }
      await this.sleep(2_000);
    }
    return `${host}: restart completed, but API readiness is still unconfirmed. Login may need approval. The bot admin can check /status; avoid repeating the restart.`;
  }
}

export const gatewayRecovery = new GatewayRecovery();
