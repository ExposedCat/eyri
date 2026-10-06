import { deepStrictEqual, equal, rejects } from "node:assert/strict";
import { Trading212Client } from "./api.ts";
import { parseTrading212Credentials } from "./credentials.ts";

Deno.test("Trading 212 client uses Basic authentication, environment and read-only endpoints", async () => {
  const calls: string[] = [];
  const client = new Trading212Client({
    apiKey: "key",
    secretKey: "secret",
    environment: "demo",
  }, {
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
  });
  await client.get("/api/v0/equity/positions");
  deepStrictEqual(calls, [
    "https://demo.trading212.com/api/v0/equity/positions",
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
  deepStrictEqual(
    parseTrading212Credentials({ apiKey: " key ", secretKey: " secret " }),
    { apiKey: "key", secretKey: "secret", environment: "live" },
  );
});

Deno.test("Trading 212 queues concurrent history requests and obeys rate-limit reset headers", async () => {
  let now = 100_000;
  const sleeps: number[] = [];
  let requests = 0;
  const client = new Trading212Client({
    apiKey: "rate",
    secretKey: "secret",
    environment: "live",
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
    environment: "live",
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
