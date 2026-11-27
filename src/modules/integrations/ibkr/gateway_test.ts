import { equal, match, rejects } from "node:assert/strict";
import { assertGatewayReady, GatewayError, GatewayMonitor } from "./gateway.ts";

Deno.test("gateway readiness is cached, shared, refreshed, and rejects a live forwarder over a dead JVM", async () => {
  let now = 0, calls = 0;
  let payload = {
    status: "unhealthy",
    state: "HALTED",
    jvm_alive: false,
    api_port_open: false,
    socat_port_open: true,
    upstream_connected: false,
  };
  const monitor = new GatewayMonitor(
    () => "http://controller/health",
    async () => {
      calls++;
      return Response.json(payload, {
        status: payload.status === "healthy" ? 200 : 503,
      });
    },
    () => now,
  );
  const [first, second] = await Promise.all([
    monitor.read("gateway"),
    monitor.read("gateway"),
  ]);
  equal(first.state, "blocked");
  equal(second.state, "blocked");
  equal(calls, 1);
  equal(first.message, "IBKR login stopped. Ask admin to check Gateway login.");
  payload = {
    status: "healthy",
    state: "READY",
    jvm_alive: true,
    api_port_open: true,
    socat_port_open: true,
    upstream_connected: true,
  };
  equal((await monitor.read("gateway")).state, "blocked");
  now = 5_001;
  equal((await monitor.read("gateway")).state, "ready");
  payload.upstream_connected = false;
  equal((await monitor.read("gateway", true)).state, "recovering");
  payload.upstream_connected = true;
  monitor.invalidate("gateway");
  equal((await monitor.read("gateway")).state, "ready");
});

Deno.test("legacy gateways make no speculative health requests; unreachable controllers are unavailable", async () => {
  let calls = 0;
  const request = (() => {
    calls++;
    throw new Error("offline");
  }) as typeof fetch;
  const legacy = new GatewayMonitor(() => undefined, request);
  equal((await legacy.read("gateway")).state, "unknown");
  equal(calls, 0);
  const controller = new GatewayMonitor(
    () => "http://controller/health",
    request,
  );
  equal((await controller.read("gateway")).state, "unavailable");
  equal(calls, 1);
});

Deno.test("controller states produce distinct short messages without guessing an expired login", async () => {
  for (const [state, message] of [
    ["LAUNCHING", "Gateway is starting. Please wait."],
    ["LOGIN", "IBKR is logging in. Please wait."],
    ["POST_LOGIN", "IBKR is logging in. Please wait."],
    ["TWO_FA", "IBKR verification pending. Complete Gateway login."],
    ["API_WAIT", "IBKR API is starting. Please wait."],
    ["UPSTREAM_DOWN", "IBKR is reconnecting. Please wait."],
    ["HALTED", "IBKR login stopped. Ask admin to check Gateway login."],
  ]) {
    const monitor = new GatewayMonitor(() => "http://controller/health", async () => Response.json({ state, status: "unhealthy" }));
    equal((await monitor.read("gateway")).message, message);
  }
});

Deno.test("UPSTREAM_DOWN without active recovery is blocked while grace-period and active relaunches stay recovering", async () => {
  const read = (payload: Record<string, unknown>) =>
    new GatewayMonitor(() => "http://controller/health", async () => Response.json(payload, { status: 503 })).read("gateway");
  const stopped = await read({
    state: "UPSTREAM_DOWN",
    status: "unhealthy",
    upstream_connected: false,
    upstream_recovery_active: false,
  });
  equal(stopped.state, "blocked");
  equal(stopped.reason, "upstream_down");
  const relaunching = await read({
    state: "UPSTREAM_DOWN",
    status: "unhealthy",
    upstream_connected: false,
    upstream_recovery_active: true,
  });
  equal(relaunching.state, "recovering");
  equal(relaunching.reason, "reconnecting");
  const graceBlip = await read({
    state: "MONITORING",
    status: "healthy",
    jvm_alive: true,
    api_port_open: true,
    socat_port_open: true,
    upstream_connected: false,
    upstream_recovery_active: false,
  });
  equal(graceBlip.state, "recovering");
  equal(graceBlip.reason, "reconnecting");
});

Deno.test("an HTTP health outage permits the socket handshake while active login and halted states stop reports", async () => {
  await assertGatewayReady("gateway", { read: async () => ({ state: "unavailable", message: "HTTP down" }) });
  for (const state of ["recovering", "blocked"] as const) {
    await rejects(assertGatewayReady("gateway", { read: async () => ({ state, message: "Exact login state. Wait." }) }),
      error => error instanceof GatewayError && error.userMessage === "Exact login state. Wait.");
  }
});
