import { equal, match } from "node:assert/strict";
import { GatewayMonitor } from "./gateway.ts";

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
  match(first.message, /session lockout or authentication/);
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
