import { deepStrictEqual, equal, rejects } from "node:assert/strict";
import { EventEmitter } from "node:events";
import { EventName, type IBApi } from "@stoqey/ib";
import { IbkrSessions } from "./session.ts";

const config = { host: "gateway", port: 4003, clientId: 0, timeoutMs: 10 };
class Api extends EventEmitter {
  disconnect() {
    this.emit(EventName.disconnected);
  }
}

Deno.test("IBKR sessions serialize concurrent account operations and reuse a ready API client", async () => {
  let connections = 0;
  const api = new Api();
  const sessions = new IbkrSessions(async (connection) => {
    equal(connection.clientId > 0, true);
    connections++;
    return api as unknown as IBApi;
  }, async () => {});
  const events: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  try {
    const first = sessions.run(config, async () => {
      events.push("first");
      await gate;
      events.push("done");
      return 1;
    });
    const second = sessions.run(config, async () => {
      events.push("second");
      return 2;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    deepStrictEqual(events, ["first"]);
    release();
    deepStrictEqual(await Promise.all([first, second]), [1, 2]);
    deepStrictEqual(events, ["first", "done", "second"]);
    equal(connections, 1);
  } finally {
    release();
    sessions.close();
  }
  deepStrictEqual(api.eventNames(), []);
});

Deno.test("connection failures fail fast during cooldown and recover on the next background poll", async () => {
  let now = 0, connections = 0;
  const sessions = new IbkrSessions(
    async () => {
      if (++connections === 1) throw new Error("refused");
      return new Api() as unknown as IBApi;
    },
    async () => {},
    () => now,
  );
  try {
    await rejects(sessions.run(config, async () => 1), /refused/);
    now = 14_999;
    await rejects(sessions.run(config, async () => 1), /refused/);
    equal(connections, 1);
    now = 15_000;
    equal(await sessions.run(config, async () => 1), 1);
    equal(connections, 2);
  } finally {
    sessions.close();
  }
});

Deno.test("upstream disconnect discards subscriptions and reconnects; report errors do not trip the gateway circuit", async () => {
  let now = 0;
  const apis: Api[] = [];
  const sessions = new IbkrSessions(
    async () => {
      const api = new Api();
      apis.push(api);
      return api as unknown as IBApi;
    },
    async () => {},
    () => now,
  );
  try {
    await sessions.run(config, async () => 1);
    apis[0].emit(EventName.error, new Error("farm ready"), 2104);
    await sessions.run(config, async () => 1);
    equal(apis.length, 1);
    apis[0].emit(EventName.error, new Error("upstream lost"), 1100);
    await rejects(sessions.run(config, async () => 1), /disconnected/);
    now = 15_001;
    await sessions.run(config, async () => 1);
    equal(apis.length, 2);
    await rejects(
      sessions.run(config, async () => {
        throw new Error("incomplete funding history");
      }),
      /incomplete funding/,
    );
    equal(await sessions.run(config, async () => 2), 2);
    equal(apis.length, 3);
    sessions.reset(config.host);
    equal(await sessions.run(config, async () => 3), 3);
    equal(apis.length, 4);
  } finally {
    sessions.close();
  }
  for (const api of apis) deepStrictEqual(api.eventNames(), []);
});
