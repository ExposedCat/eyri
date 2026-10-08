import { deepStrictEqual, equal, rejects } from "node:assert/strict";
import { Trading212Client } from "./api.ts";
import { parseTrading212Credentials } from "./credentials.ts";

Deno.test("account reads and export generation stay on dedicated endpoints with independent pacing", async () => {
  let now = 100_000;
  const sleeps: number[] = [], methods: string[] = [];
  const client = new Trading212Client({
    apiKey: "export-rate",
    secretKey: "secret",
  }, {
    now: () => now,
    sleep: (ms) => {
      sleeps.push(ms);
      now += ms;
      return Promise.resolve();
    },
    fetch: (input, init) => {
      const url = new URL(String(input));
      methods.push(init!.method!);
      if (init?.method === "POST") {
        equal(url.pathname, "/api/v0/equity/history/exports");
        equal(
          new Headers(init.headers).get("Content-Type"),
          "application/json",
        );
        return Promise.resolve(Response.json({ reportId: 1 }));
      }
      return Promise.resolve(Response.json([]));
    },
  });
  const body = {
    timeFrom: "2025-01-01T00:00:00Z",
    timeTo: "2026-01-01T00:00:00Z",
    dataIncluded: {
      includeDividends: true,
      includeInterest: true,
      includeOrders: true,
      includeTransactions: true,
    },
  };
  await client.requestReport(body);
  deepStrictEqual(sleeps, []);
  await client.get("/api/v0/equity/account/summary");
  await client.get("/api/v0/equity/history/exports");
  await client.requestReport(body);
  deepStrictEqual(sleeps, [30_100]);
  deepStrictEqual(methods, ["POST", "GET", "GET", "POST"]);
});

Deno.test("Trading 212 client uses Basic authentication and live-only read endpoints", async () => {
  const calls: string[] = [];
  const client = new Trading212Client(
    parseTrading212Credentials({
      apiKey: "key",
      secretKey: "secret",
      // Legacy stored environment values must not switch the API to demo.
      environment: "demo",
    }),
    {
      fetch: (input, init) => {
        calls.push(String(input));
        equal(init?.method, "GET");
        equal(init?.redirect, "error");
        equal(
          new Headers(init?.headers).get("Authorization"),
          `Basic ${btoa("key:secret")}`,
        );
        return Promise.resolve(Response.json([]));
      },
    },
  );
  await client.get("/api/v0/equity/positions");
  deepStrictEqual(calls, [
    "https://live.trading212.com/api/v0/equity/positions",
  ]);
  for (
    const path of [
      "https://attacker.example/api/v0/equity/positions",
      "//attacker.example/api/v0/equity/positions",
      "/api/v0/equity/orders/market",
    ]
  ) {
    await rejects(client.get(path), /Invalid Trading 212 API path/);
  }
  equal(calls.length, 1);
  await client.get("/api/v0/equity/history/transactions?limit=50");
  equal(
    calls.at(-1),
    "https://live.trading212.com/api/v0/equity/history/transactions?limit=50",
  );
  deepStrictEqual(
    parseTrading212Credentials({ apiKey: " key ", secretKey: " secret " }),
    { apiKey: "key", secretKey: "secret" },
  );
});

Deno.test("Trading 212 cash history pacing respects the six-per-minute transaction limit", async () => {
  let now = 100_000;
  const sleeps: number[] = [];
  const client = new Trading212Client({
    apiKey: "cash-rate",
    secretKey: "secret",
  }, {
    now: () => now,
    sleep: (ms) => {
      sleeps.push(ms);
      now += ms;
      return Promise.resolve();
    },
    fetch: () =>
      Promise.resolve(Response.json({ items: [], nextPagePath: null })),
  });
  await Promise.all([
    client.get("/api/v0/equity/history/transactions?limit=50"),
    client.get("/api/v0/equity/history/transactions?cursor=1"),
  ]);
  deepStrictEqual(sleeps, [10_100]);
});

Deno.test("Trading 212 queues concurrent history requests and obeys rate-limit reset headers", async () => {
  let now = 100_000;
  const sleeps: number[] = [];
  let requests = 0;
  const client = new Trading212Client({
    apiKey: "rate",
    secretKey: "secret",
  }, {
    now: () => now,
    sleep: (ms) => {
      sleeps.push(ms);
      now += ms;
      return Promise.resolve();
    },
    fetch: () => {
      requests++;
      if (requests === 1) {
        return Promise.resolve(
          new Response(null, {
            status: 429,
            headers: { "x-ratelimit-reset": "104" },
          }),
        );
      }
      return Promise.resolve(Response.json({ items: [], nextPagePath: null }));
    },
  });
  await Promise.all([
    client.get("/api/v0/equity/history/orders?limit=50"),
    client.get("/api/v0/equity/history/orders?cursor=1"),
  ]);
  equal(requests, 3);
  deepStrictEqual(sleeps, [4_000, 3_100]);
});

Deno.test("Trading 212 errors never expose broker response bodies or credentials", async () => {
  const client = new Trading212Client({
    apiKey: "PRIVATEKEY",
    secretKey: "PRIVATESECRET",
  }, {
    fetch: () =>
      Promise.resolve(new Response("PRIVATESECRET", { status: 403 })),
  });
  await rejects(client.get("/api/v0/equity/positions"), (error: Error) => {
    equal(
      error.message,
      "Trading 212 API returned HTTP 403: check read permissions and IP restrictions",
    );
    return true;
  });
});
