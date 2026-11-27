import { deepStrictEqual, equal, match, rejects } from "node:assert/strict";
import type { Integration } from "../../database/integration.ts";
import { GatewayError, type GatewayHealth } from "./gateway.ts";
import { GatewayRecovery, restartGatewayContainer } from "./recovery.ts";
import { GatewayWatchdog } from "./watchdog.ts";

function failureMessage(result: Awaited<ReturnType<GatewayRecovery["handleFailure"]>>) {
  if (result === "retry") throw new Error("Expected a user-facing error");
  return result?.userMessage;
}

Deno.test("command recovery returns after dispatch, shares restarts, and never restarts an active login", async () => {
  let finish!: () => void;
  const pending = new Promise<void>(resolve => { finish = resolve; });
  let state: GatewayHealth = { state: "unavailable", message: "status unreachable" };
  let restarts = 0;
  const recovery = new GatewayRecovery(async () => state, async () => { throw new Error("offline"); },
    async (_host, requested) => { restarts++; requested?.(); await pending; }, () => {});
  try {
    const first = await recovery.handleFailure(integration, new GatewayError("gateway", state));
    equal(failureMessage(first), "IBKR API is unreachable. Gateway restart requested; please wait.");
    const second = await recovery.handleFailure(integration, new GatewayError("gateway", state));
    equal(failureMessage(second), "Gateway is restarting. Please wait.");
    equal(restarts, 1);
    equal(await recovery.handleFailure(integration, new Error("IBKR funding rows differ")), null);
  } finally { finish(); await recovery.restart(integration); }
  state = { state: "recovering", message: "IBKR is logging in. Please wait." };
  equal(failureMessage(await recovery.handleFailure(integration, new GatewayError("gateway", state))), state.message);
  equal(restarts, 1);
});

Deno.test("command recovery preserves a healthy socket despite a broken HTTP check and reports failed restart requests", async () => {
  let restarts = 0;
  const down = { state: "unavailable" as const, message: "status unreachable" };
  const healthy = new GatewayRecovery(async () => down, async () => {}, async () => { restarts++; }, () => {});
  equal(await healthy.handleFailure(integration, new GatewayError("gateway", down)), "retry");
  equal(restarts, 0);
  const failed = new GatewayRecovery(async () => down, async () => { throw new Error("offline"); },
    async () => { restarts++; throw new Error("socket denied"); }, () => {});
  equal(failureMessage(await failed.handleFailure(integration, new GatewayError("gateway", down))),
    "Gateway restart failed. Ask admin to check /status.");
  equal(failureMessage(await failed.handleFailure(integration, new GatewayError("gateway", down))),
    "Gateway restart failed. Ask admin to check /status.");
  equal(restarts, 1);
});

Deno.test("reports retry a halted login without assuming the session expired", async () => {
  const halted = { state: "blocked" as const, message: "IBKR login stopped. Ask admin to check Gateway login." };
  let restarts = 0;
  const recovery = new GatewayRecovery(async () => halted, async () => {},
    async (_host, requested) => { restarts++; requested?.(); }, () => {});
  equal(failureMessage(await recovery.handleFailure(integration, new GatewayError("gateway", halted))),
    "IBKR login stopped. Gateway restart requested; please wait.");
  equal(restarts, 1);
  equal(failureMessage(await recovery.handleFailure(integration, new GatewayError("gateway", halted))),
    "IBKR login stopped again. Eyri will retry automatically.");
  equal(restarts, 1);
  const expired = new GatewayRecovery(async () => halted, async () => { throw new Error("offline"); },
    async (_host, requested) => { restarts++; requested?.(); }, () => {});
  equal(failureMessage(await expired.handleFailure(integration, new Error("IBKR session expired"))),
    "IBKR session expired. Gateway restart requested; please wait.");
  equal(restarts, 2);
});
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

Deno.test("recovery leaves a working API and an active login running", async () => {
  let state: GatewayHealth["state"] = "ready", restarts = 0, probes = 0;
  const recovery = new GatewayRecovery(async () => health(state), async () => {
    probes++;
  }, async () => {
    restarts++;
  });
  equal(await recovery.recover(integration), "gateway: API is ready; restart was unnecessary.");
  state = "unavailable";
  equal(await recovery.recover(integration), "gateway: API is ready; restart was unnecessary.");
  state = "recovering";
  equal(await recovery.recover(integration), "gateway: recovering");
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
  equal(await first, "gateway: API readiness confirmed.");
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

Deno.test("restart progress follows approval through a successful API check and shares concurrent requests", async () => {
  const waiting = Promise.withResolvers<void>();
  const approved = Promise.withResolvers<void>();
  const verification: GatewayHealth = { ...health("recovering"), reason: "verification" };
  const observations: GatewayHealth[] = [
    health("unavailable"),
    { ...health("recovering"), reason: "starting" },
    { ...health("recovering"), reason: "login" },
    verification,
    health("unavailable"),
    verification,
    { ...health("recovering"), reason: "api_starting" },
  ];
  let now = 0, restarts = 0, probes = 0, polls = 0;
  const recovery = new GatewayRecovery(
    async () => observations[polls++] ?? health("ready"),
    async () => { if (++probes < 4) throw new Error("still connecting"); },
    async () => { restarts++; },
    () => {},
    () => now,
    async (ms) => {
      if (polls === 4) {
        waiting.resolve();
        await approved.promise;
      }
      now += ms;
    },
  );
  const first: string[] = [], joined: string[] = [];
  const completion = recovery.restartAndFollow(integration, (message) => first.push(message));
  equal(first[0], "Restarting IB Gateway…");
  await waiting.promise;
  const second = recovery.restartAndFollow({ ...integration, id: 2 }, (message) => joined.push(message));
  equal(second, completion);
  equal(joined[0], first.at(-1));
  match(joined[0], /^Waiting for 2FA approval/);
  const error = new GatewayError("gateway", { ...health("unavailable"), reason: "health_unavailable" });
  equal(failureMessage(await recovery.handleFailure(integration, error)), joined[0]);
  equal(probes, 1);
  approved.resolve();
  await completion;

  deepStrictEqual(first, [
    "Restarting IB Gateway…",
    "IB Gateway is starting up…",
    "Signing in to IBKR…",
    "Waiting for 2FA approval. If IBKR sends a prompt, approve it in the app.",
    "Connecting to IBKR…",
    "IB Gateway is ready.",
  ]);
  deepStrictEqual(joined, first.slice(3));
  equal(restarts, 1);
  equal(probes, 4);
});

Deno.test("restart progress reports a login halt or a timeout without claiming readiness", async () => {
  for (const [status, message] of [
    [{ ...health("blocked"), reason: "halted" }, /stopped trying to sign in/],
    [{ ...health("recovering"), reason: "verification" }, /still waiting for 2FA approval/],
    [health("unavailable"), /still wasn’t ready after 10 minutes/],
  ] as const) {
    let now = 0, restarts = 0;
    const recovery = new GatewayRecovery(
      async () => status,
      async () => { throw new Error("API offline"); },
      async () => { restarts++; },
      () => {},
      () => now,
      async (ms) => { now += ms; },
    );
    const updates: string[] = [];
    await rejects(recovery.restartAndFollow(integration, (update) => updates.push(update)), message);
    equal(now, status.state === "blocked" ? 0 : 600_000);
    equal(updates.length, status.state === "recovering" ? 2 : 1);
    equal(restarts, 1);
  }
});

Deno.test("a report lets an existing login finish and retries it if it halts", async () => {
  const verification: GatewayHealth = { ...health("recovering"), reason: "verification" };
  let polls = 0, restarts = 0, probes = 0;
  const recovery = new GatewayRecovery(
    async () => {
      polls++;
      if (restarts) return health("ready");
      return polls < 3 ? verification : health("blocked");
    },
    async () => { probes++; },
    async () => {
      equal(polls, 4);
      restarts++;
    },
    () => {},
    () => 0,
    async () => {},
  );
  const progress: string[] = [];
  const result = await recovery.handleFailure(integration, new GatewayError("gateway", verification), {
    userId: integration.userId,
    onProgress: (_host, message) => progress.push(message),
  });
  equal(result, "retry");
  equal(restarts, 1);
  equal(probes, 1);
  equal(progress.length, 3);
  match(progress[0], /^Waiting for 2FA approval/);
  deepStrictEqual(progress.slice(1), ["Restarting IB Gateway…", "Connecting to IBKR…"]);
});

Deno.test("reports restart UPSTREAM_DOWN gateways when the controller is not recovering them", async () => {
  const upstreamDown: GatewayHealth = {
    state: "blocked",
    reason: "upstream_down",
    message: "IBKR server connection is down. Restart Gateway to reconnect.",
  };
  let restarted = false, restarts = 0, probes = 0;
  const recovery = new GatewayRecovery(
    async () => restarted ? health("ready") : upstreamDown,
    async () => { probes++; },
    async () => { restarted = true; restarts++; },
    () => {},
    () => 0,
    async () => {},
  );
  const progress: string[] = [];
  const result = await recovery.handleFailure(integration, new GatewayError("gateway", upstreamDown), {
    userId: integration.userId,
    onProgress: (_host, message) => progress.push(message),
  });
  equal(result, "retry");
  equal(restarts, 1);
  equal(probes, 1);
  deepStrictEqual(progress, ["Restarting IB Gateway…", "Connecting to IBKR…"]);
});

Deno.test("explicit restart supersedes a passive follow without restarting for a second passive report", async () => {
  const reconnecting: GatewayHealth = { ...health("recovering"), reason: "reconnecting" };
  const sleeping = Promise.withResolvers<void>();
  const releaseSleep = Promise.withResolvers<void>();
  let restarted = false, restarts = 0, probes = 0;
  const recovery = new GatewayRecovery(
    async () => restarted ? health("ready") : reconnecting,
    async () => { probes++; },
    async () => { restarted = true; restarts++; },
    () => {},
    () => 0,
    async () => {
      if (!restarted) {
        sleeping.resolve();
        await releaseSleep.promise;
      }
    },
  );
  const report1: string[] = [], report2: string[] = [], manual: string[] = [];
  const firstReport = recovery.handleFailure(integration, new GatewayError("gateway", reconnecting), {
    userId: integration.userId,
    onProgress: (_host, message) => report1.push(message),
  });
  await sleeping.promise;
  // Another report joining the passive follow must not trigger a restart.
  const secondReport = recovery.handleFailure(integration, new GatewayError("gateway", reconnecting), {
    userId: integration.userId,
    onProgress: (_host, message) => report2.push(message),
  });
  await Promise.resolve();
  equal(restarts, 0);
  // Explicit /restart_gateway supersedes the passive wait, restarts, and wakes waiting reports.
  await recovery.restartAndFollow(integration, (message) => manual.push(message));
  releaseSleep.resolve();
  equal(await firstReport, "retry");
  equal(await secondReport, "retry");
  equal(restarts, 1);
  equal(probes, 1);
  deepStrictEqual(manual, ["Restarting IB Gateway…", "Connecting to IBKR…", "IB Gateway is ready."]);
  deepStrictEqual(report1, ["Reconnecting to IBKR…", "Restarting IB Gateway…", "Connecting to IBKR…"]);
  deepStrictEqual(report2, ["Reconnecting to IBKR…", "Restarting IB Gateway…", "Connecting to IBKR…"]);
});

Deno.test("shared-gateway reports follow recovery with neutral 2FA wording", async () => {
  const verification: GatewayHealth = { ...health("recovering"), reason: "verification" };
  const sleeping = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let ready = false, restarts = 0;
  const recovery = new GatewayRecovery(
    async () => ready ? health("ready") : verification,
    async () => {},
    async () => { restarts++; },
    () => {},
    () => 0,
    async () => {
      sleeping.resolve();
      await release.promise;
    },
  );
  const viewerProgress: string[] = [];
  const ownerProgress: string[] = [];
  const viewerReport = recovery.handleFailure(integration, new GatewayError("gateway", verification), {
    userId: integration.userId + 1,
    onProgress: (_host, message) => viewerProgress.push(message),
  });
  await sleeping.promise;
  const ownerReport = recovery.handleFailure(integration, new GatewayError("gateway", verification), {
    userId: integration.userId,
    onProgress: (_host, message) => ownerProgress.push(message),
  });
  ready = true;
  release.resolve();
  equal(await viewerReport, "retry");
  equal(await ownerReport, "retry");
  equal(restarts, 0);
  deepStrictEqual(viewerProgress, ["Waiting for 2FA approval.", "Connecting to IBKR…"]);
  deepStrictEqual(ownerProgress, [
    "Waiting for 2FA approval. If IBKR sends a prompt, approve it in the app.",
    "Connecting to IBKR…",
  ]);
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
  equal(await recovery.recover(integration), "gateway: API readiness confirmed.");
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
  match(await recovery.recover(integration) ?? "", /readiness is still unconfirmed/);
  equal(now, 180_000);
});

Deno.test("watchdog waits for a sustained controller outage and backs off for repeat outages", async () => {
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
  for (const next of ["recovering", "unknown", "ready"] as const) {
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

Deno.test("the watchdog restarts a halted login and shares its retry interval with reports", async () => {
  const halted = health("blocked");
  const restarting = Promise.withResolvers<void>();
  const started = Promise.withResolvers<void>();
  let now = 0, restarts = 0, probes = 0;
  let state = halted;
  const recovery = new GatewayRecovery(
    async () => state,
    async () => { probes++; },
    async () => {
      if (++restarts === 2) {
        restarting.resolve();
        await started.promise;
        state = health("ready");
      }
    },
    () => {},
    () => now,
  );
  const watchdog = new GatewayWatchdog(async () => state, (item) => recovery.recover(item), () => now);
  const error = new GatewayError("gateway", halted);

  await watchdog.check(integration);
  equal(restarts, 1);
  now = 15 * 60_000 - 1;
  await watchdog.check(integration);
  equal(failureMessage(await recovery.handleFailure(integration, error)),
    "IBKR login stopped again. Eyri will retry automatically.");
  equal(restarts, 1);
  equal(probes, 0);

  now++;
  const secondCheck = watchdog.check(integration);
  await restarting.promise;
  const messages: string[] = [];
  const report = recovery.handleFailure(integration, error, {
    userId: integration.userId,
    onProgress: (_host, message) => {
      messages.push(message);
      started.resolve();
    },
  });
  equal(await report, "retry");
  await secondCheck;
  deepStrictEqual(messages, ["Restarting IB Gateway…", "Connecting to IBKR…"]);
  equal(restarts, 2);
  equal(probes, 2);
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
