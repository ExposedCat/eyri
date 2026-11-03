import { equal, match } from "node:assert/strict";
import type { Integration } from "../../database/integration.ts";
import type { GatewayHealth } from "./gateway.ts";
import { GatewayRecovery, restartGatewayContainer } from "./recovery.ts";
import { GatewayWatchdog } from "./watchdog.ts";

const integration: Integration = {
  id: 1,
  userId: 1,
  kind: "ibkr",
  createdAt: new Date(),
  updatedAt: new Date(),
  credentials: { instanceUrl: "tcp://gateway:4003" },
};
const health = (state: GatewayHealth["state"]): GatewayHealth => ({
  state,
  message: state,
});

Deno.test("recovery leaves healthy, recovering and authentication-halted gateways running", async () => {
  let state: GatewayHealth["state"] = "ready", restarts = 0, probes = 0;
  const recovery = new GatewayRecovery(async () => health(state), async () => {
    probes++;
  }, async () => {
    restarts++;
  });
  match(await recovery.recover(integration), /API is ready/);
  state = "unavailable";
  match(await recovery.recover(integration), /API is ready/);
  state = "recovering";
  match(await recovery.recover(integration), /recovering/);
  state = "blocked";
  match(await recovery.recover(integration), /restart force/);
  equal(restarts, 0);
  equal(probes, 2);
});

Deno.test("recovery coalesces commands, confirms API readiness and prevents repeated restart attempts", async () => {
  let state: GatewayHealth["state"] = "unavailable",
    restarts = 0,
    probes = 0,
    now = 0;
  const recovery = new GatewayRecovery(
    async () => health(state),
    async () => {
      probes++;
      if (!restarts) throw new Error("offline");
    },
    async () => {
      restarts++;
      state = "ready";
    },
    () => {},
    () => now,
    async (ms) => {
      now += ms;
    },
  );
  const first = recovery.recover(integration);
  equal(recovery.recover(integration), first);
  match(await first, /API readiness confirmed/);
  equal(probes, 2);
  equal(restarts, 1);
  match(await recovery.recover(integration, true), /15 minutes/);
  equal(restarts, 1);
});

Deno.test("restart success is not reported as API readiness when login never completes", async () => {
  let now = 0;
  const recovery = new GatewayRecovery(
    async () => health("unavailable"),
    async () => {
      throw new Error("offline");
    },
    async () => {},
    () => {},
    () => now,
    async (ms) => {
      now += ms;
    },
  );
  match(await recovery.recover(integration), /readiness is still unconfirmed/);
  equal(now, 180_000);
});

Deno.test("watchdog waits for a sustained controller outage, backs off, and never restarts deliberate halts", async () => {
  let state: GatewayHealth["state"] = "unavailable", now = 0, restarts = 0;
  const watchdog = new GatewayWatchdog(async () => health(state), async () => {
    restarts++;
    return "restarting";
  }, () => now);
  await watchdog.check(integration);
  now = 119_999;
  await watchdog.check(integration);
  equal(restarts, 0);
  now = 120_000;
  await watchdog.check(integration);
  equal(restarts, 1);
  now = 150_000;
  await watchdog.check(integration);
  equal(restarts, 1);
  for (const next of ["blocked", "recovering", "unknown", "ready"] as const) {
    state = next;
    now += 900_000;
    await watchdog.check(integration);
  }
  equal(restarts, 1);
  state = "unavailable";
  await watchdog.check(integration);
  now += 120_000;
  await watchdog.check(integration);
  equal(restarts, 2);
});

Deno.test("Podman restart explicitly allows 90 seconds for graceful logout", async () => {
  const dir = await Deno.makeTempDir({ prefix: "eyri-podman-test-" });
  const path = `${dir}/socket`;
  const previous = Deno.env.get("PODMAN_SOCKET_PATH");
  Deno.env.set("PODMAN_SOCKET_PATH", path);
  const listener = Deno.listen({ transport: "unix", path });
  const server = (async () => {
    const conn = await listener.accept();
    try {
      const buffer = new Uint8Array(4096);
      let request = "";
      while (!request.includes("\r\n\r\n")) {
        const size = await conn.read(buffer);
        if (size === null) break;
        request += new TextDecoder().decode(buffer.subarray(0, size));
      }
      match(request, /^POST \/containers\/gateway\/restart\?t=90 HTTP\/1.1/);
      await conn.write(
        new TextEncoder().encode(
          "HTTP/1.1 204 No Content\r\nConnection: close\r\n\r\n",
        ),
      );
    } finally {
      conn.close();
    }
  })();
  try {
    await restartGatewayContainer("gateway");
    await server;
  } finally {
    listener.close();
    if (previous === undefined) Deno.env.delete("PODMAN_SOCKET_PATH");
    else Deno.env.set("PODMAN_SOCKET_PATH", previous);
    await Deno.remove(dir, { recursive: true });
  }
});
