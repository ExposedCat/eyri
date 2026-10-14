import { EventName, IBApi } from "@stoqey/ib";

export type IbkrConnectionConfig = {
  host: string;
  port: number;
  accountId?: string;
  clientId: number;
  timeoutMs: number;
};

export function connectIbkrOnce(
  config: IbkrConnectionConfig,
  createApi = (host: string, port: number) => new IBApi({ host, port }),
): Promise<IBApi> {
  const api = createApi(config.host, config.port);
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      api.off(EventName.connected, onConnected);
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
        cleanup();
        resolve(api);
      }
    };
    const onConnected = () => finish();
    const onDisconnected = () =>
      finish(
        new Error(
          `IBKR Gateway disconnected during connection to ${config.host}:${config.port}`,
        ),
      );
    const onError = (error: unknown, code?: number) => {
      if (code !== undefined && code >= 2100 && code <= 2199) return;
      finish(error instanceof Error ? error : new Error(String(error)));
    };
    const timer = setTimeout(() =>
      finish(
        new Error(
          `Timed out connecting to IBKR Gateway at ${config.host}:${config.port}`,
        ),
      ), config.timeoutMs);
    api.on(EventName.connected, onConnected);
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
  const deadline = Date.now() + config.timeoutMs;
  while (true) {
    try {
      return await connectIbkrOnce({
        ...config,
        timeoutMs: Math.max(1, deadline - Date.now()),
      });
    } catch (error) {
      const remaining = deadline - Date.now();
      if (remaining <= 1_000) throw error;
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
  }
}
