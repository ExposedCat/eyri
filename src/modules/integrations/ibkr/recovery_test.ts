import { equal, match, rejects } from "node:assert/strict";
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
  equal(await recovery.recover(integration), "gateway: blocked");
  equal(restarts, 0);
  equal(probes, 2);
});

Deno.test("recovery coalesces concurrent attempts and confirms readiness after restarting", async () => {
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
});

Deno.test("manual restart bypasses health checks and readiness waits in every gateway state", async () => {
  const restarted: string[] = [], reset: string[] = [];
  for (const state of ["ready", "recovering", "blocked", "unknown", "unavailable"] as const) {
    const recovery = new GatewayRecovery(
      () => { throw new Error(`Manual restart must not check ${state} health`); },
      () => { throw new Error("Manual restart must not probe the API"); },
      async (host) => { restarted.push(host); },
      (host) => { reset.push(host); },
      () => 0,
      () => { throw new Error("Manual restart must not wait for readiness"); },
    );
    equal(await recovery.restart(integration), "gateway: restarted.");
    equal(await recovery.restart(integration), "gateway: restarted.");
  }
  equal(restarted.length, 10);
  equal(reset.length, 10);
  equal(restarted.every(host => host === "gateway"), true);
  equal(reset.every(host => host === "gateway"), true);
});

Deno.test("manual restart shares concurrent requests per host and waits for Podman completion", async () => {
  let finish!: () => void;
  const stopped = new Promise<void>(resolve => { finish = resolve; });
  const restarted: string[] = [];
  const recovery = new GatewayRecovery(
    () => { throw new Error("Unexpected health check"); },
    () => { throw new Error("Unexpected API probe"); },
    async (host) => { restarted.push(host); await stopped; },
    () => {},
  );
  const first = recovery.restart(integration);
  equal(recovery.restart({ ...integration, id: 2 }), first);
  const other = recovery.restart({ ...integration, credentials: { instanceUrl: "tcp://other:4003" } });
  equal(restarted.join(","), "gateway,other");
  let completed = false;
  void first.then(() => { completed = true; });
  await Promise.resolve();
  equal(completed, false);
  finish();
  equal(await first, "gateway: restarted.");
  equal(await other, "other: restarted.");
});

Deno.test("manual restart failures can be retried immediately", async () => {
  let attempts = 0;
  const recovery = new GatewayRecovery(
    () => { throw new Error("Unexpected health check"); },
    () => { throw new Error("Unexpected API probe"); },
    async () => { if (++attempts === 1) throw new Error("Podman unavailable"); },
    () => {},
  );
  await rejects(recovery.restart(integration), /Podman unavailable/);
  equal(await recovery.restart(integration), "gateway: restarted.");
  equal(attempts, 2);
});

Deno.test("a failed restart can be retried immediately without force or a cooldown", async () => {
  let restarts = 0;
  const recovery = new GatewayRecovery(
    async () => health("unavailable"),
    async () => { if (restarts < 2) throw new Error("offline"); },
    async () => { if (++restarts === 1) throw new Error("Podman unavailable"); },
    () => {},
    () => 0,
    async () => { throw new Error("Unexpected wait"); },
  );
  await rejects(recovery.recover(integration), /Podman unavailable/);
  match(await recovery.recover(integration), /API readiness confirmed/);
  equal(restarts, 2);
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
