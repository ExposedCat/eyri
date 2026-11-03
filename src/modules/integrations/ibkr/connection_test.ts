import { deepStrictEqual, equal, rejects } from "node:assert/strict";
import { EventEmitter } from "node:events";
import { EventName, type IBApi } from "@stoqey/ib";
import { connectIbkrOnce } from "./connection.ts";

const config = { host: "gateway", port: 4003, clientId: 1000, timeoutMs: 10 };

class Api extends EventEmitter {
  disconnected = false;
  start: () => void = () => {};
  connect() {
    this.start();
  }
  disconnect() {
    this.disconnected = true;
    this.emit(EventName.disconnected);
  }
}

for (const failure of ["timeout", "error", "disconnect", "throw"] as const) {
  Deno.test(`IBKR failed connection cleans up the socket and listeners: ${failure}`, async () => {
    const api = new Api();
    api.start = () => {
      if (failure === "error") {
        api.emit(EventName.error, new Error("ECONNREFUSED"));
      }
      if (failure === "disconnect") api.emit(EventName.disconnected);
      if (failure === "throw") throw new Error("connect threw");
    };
    await rejects(connectIbkrOnce(config, () => api as unknown as IBApi));
    equal(api.disconnected, true);
    deepStrictEqual(api.eventNames(), []);
  });
}

Deno.test("IBKR connection ignores farm status messages and preserves a successful socket", async () => {
  const api = new Api();
  api.start = () => {
    api.emit(EventName.error, new Error("Market data farm connected"), 2104);
    api.emit(EventName.connected);
    api.emit(EventName.nextValidId, 1);
    api.emit(EventName.error, new Error("farm ready in same packet"), 2104);
  };
  equal(await connectIbkrOnce(config, () => api as unknown as IBApi), api);
  equal(api.disconnected, false);
  equal(api.listenerCount(EventName.nextValidId), 0);
  api.disconnect();
  deepStrictEqual(api.eventNames(), []);
});

Deno.test("IBKR TCP connected is insufficient until the API handshake finishes", async () => {
  const api = new Api();
  api.start = () => api.emit(EventName.connected);
  await rejects(
    connectIbkrOnce(config, () => api as unknown as IBApi),
    /Timed out/,
  );
  equal(api.disconnected, true);
});
