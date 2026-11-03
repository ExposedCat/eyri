import { EventName, type IBApi } from "@stoqey/ib";
import { connectIbkr, type IbkrConnectionConfig } from "./connection.ts";
import { assertGatewayReady } from "./gateway.ts";

type Session = {
  api?: IBApi;
  tail: Promise<unknown>;
  retryAt: number;
  error?: Error;
  close?: () => void;
  idle?: ReturnType<typeof setTimeout>;
  clientId: number;
  closed?: boolean;
};

// Serialize operations on each API client: account subscriptions and request
// IDs are client-scoped. Keep successful sockets rather than reconnecting for
// every command. Execution polling supplies activity every 15 seconds.
export class IbkrSessions {
  private sessions = new Map<string, Session>();
  constructor(
    private connect = connectIbkr,
    private ready = assertGatewayReady,
    private now = Date.now,
    private idleMs = 60_000,
  ) {}

  run<T>(
    config: IbkrConnectionConfig,
    action: (api: IBApi) => Promise<T>,
  ): Promise<T> {
    const key = JSON.stringify([config.host, config.port, config.clientId]);
    let session = this.sessions.get(key);
    if (!session) {
      session = {
        tail: Promise.resolve(),
        retryAt: 0,
        clientId: config.clientId ||
          10_000 +
            crypto.getRandomValues(new Uint32Array(1))[0] % 1_000_000_000,
      };
      this.sessions.set(key, session);
    }
    const current = session;
    const request = current.tail.then(async () => {
      clearTimeout(current.idle);
      let runningAction = false;
      let cachedFailure = false;
      try {
        await this.ready(config.host);
        if (current.closed) {
          throw new Error("IBKR connection was reset; retry the request.");
        }
        if (this.now() < current.retryAt) {
          cachedFailure = true;
          throw current.error;
        }
        if (!current.api) {
          const api = await this.connect({
            ...config,
            clientId: current.clientId,
          });
          current.api = api;
          const onDisconnected = () => {
            current.error = new Error(
              "IBKR Gateway disconnected. Reconnection will be attempted shortly.",
            );
            current.retryAt = this.now() + 15_000;
            current.close?.();
          };
          const onError = (_error: unknown, code?: number) => {
            // Farm notifications are informational. A lost upstream session
            // must discard the client so subscriptions are recreated next time.
            if (
              code === 1100 || code === 1300 || code === 502 || code === 504
            ) onDisconnected();
          };
          current.close = () => {
            current.api = undefined;
            current.close = undefined;
            api.off(EventName.disconnected, onDisconnected);
            api.off(EventName.error, onError);
            api.disconnect();
          };
          api.on(EventName.disconnected, onDisconnected);
          api.on(EventName.error, onError);
        }
        // Only connection failures trip the circuit. A report validation error
        // must not prevent unrelated reports from using a healthy gateway.
        const api = current.api;
        if (!api) {
          throw new Error("IBKR Gateway disconnected before the request.");
        }
        runningAction = true;
        return await action(api);
      } catch (error) {
        current.close?.();
        if (!runningAction && !cachedFailure) {
          current.error = error instanceof Error
            ? error
            : new Error(String(error));
          current.retryAt = this.now() + 15_000;
        }
        throw error;
      } finally {
        if (!current.closed) {
          current.idle = setTimeout(() => {
            current.close?.();
            if (this.sessions.get(key) === current) this.sessions.delete(key);
          }, this.idleMs);
        }
        if (current.idle !== undefined) Deno.unrefTimer(current.idle);
      }
    });
    current.tail = request.catch(() => {});
    return request;
  }

  close() {
    for (const session of this.sessions.values()) {
      clearTimeout(session.idle);
      session.closed = true;
      session.close?.();
    }
    this.sessions.clear();
  }

  reset(host: string) {
    for (const [key, session] of this.sessions) {
      if (JSON.parse(key)[0] !== host) continue;
      clearTimeout(session.idle);
      session.closed = true;
      session.close?.();
      this.sessions.delete(key);
    }
  }
}

export const ibkrSessions = new IbkrSessions();
