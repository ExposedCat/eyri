import { EventName, IBApi } from "@stoqey/ib";
import { assertGatewayReady } from "./gateway.ts";

export type IbkrConnectionConfig = {
  host: string;
  port: number;
  accountId?: string;
  clientId: number;
  timeoutMs: number;
};

export function isIbkrStatusMessage(code?: number) {
  return code === 1101 || code === 1102 ||
    (code !== undefined && code >= 2100 && code <= 2199);
}

export function connectIbkrOnce(
  config: IbkrConnectionConfig,
  createApi = (host: string, port: number) => new IBApi({ host, port }),
): Promise<IBApi> {
  const api = createApi(config.host, config.port);
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      api.off(EventName.nextValidId, onConnected);
      api.off(EventName.error, onError);
      api.off(EventName.disconnected, onDisconnected);
    };
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      if (error) {
        // Keep the error listener until disconnect completes, then remove all
        // connection listeners even if disconnect itself throws.
        try {
          api.disconnect();
        } catch {
          // Report the original connection failure even if closing also fails.
        } finally {
          cleanup();
          reject(error);
        }
      } else {
        clearTimeout(timer);
        api.off(EventName.nextValidId, onConnected);
        // Keep a lifetime error listener until disconnect. Farm notifications
        // can arrive in the same packet as nextValidId, before the caller can
        // install its request listeners.
        resolve(api);
      }
    };
    const onConnected = () => finish();
    const onDisconnected = () => {
      if (settled) {
        cleanup();
        return;
      }
      finish(
        new Error(
          `IBKR Gateway disconnected during connection to ${config.host}:${config.port}`,
        ),
      );
    };
    const onError = (error: unknown, code?: number) => {
      if (isIbkrStatusMessage(code)) return;
      finish(error instanceof Error ? error : new Error(String(error)));
    };
    const timer = setTimeout(() =>
      finish(
        new Error(
          `Timed out connecting to IBKR Gateway at ${config.host}:${config.port}`,
        ),
      ), config.timeoutMs);
    // A TCP connection alone is not API readiness. Wait for the completed
    // handshake before sending requests (IBKR can otherwise drop them).
    api.on(EventName.nextValidId, onConnected);
    api.on(EventName.error, onError);
    api.on(EventName.disconnected, onDisconnected);
    try {
      api.connect(config.clientId);
    } catch (error) {
      onError(error);
    }
  });
}

export async function connectIbkr(config: IbkrConnectionConfig) {
  await assertGatewayReady(config.host);
  // Reconnection belongs to background polling, not a retry/sleep loop in
  // every user's report. A refused connection should fail immediately.
  return await connectIbkrOnce(config);
}
