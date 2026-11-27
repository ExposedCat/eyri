import { deepStrictEqual as assertEquals, ok as assert } from "node:assert/strict";
import { Database } from "@db/sqlite";
import { ensureSchema } from "../database/setup.ts";
import { findOrCreateUser } from "../database/user.ts";
import { ensureWebSchema, sha256Bytes } from "./auth.ts";
import { clearMarketCaches } from "./market.ts";
import { createWebHttpHandler } from "./server.ts";

async function signTelegram(fields: Record<string, string | number>, token: string) {
  const check = Object.entries(fields)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
  const key = await crypto.subtle.importKey(
    "raw",
    (await sha256Bytes(token)) as BufferSource,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(check)));
  const hash = [...sig].map((b) => b.toString(16).padStart(2, "0")).join("");
  return { ...fields, hash };
}

Deno.test("Web HTTP server enforces Telegram OAuth, security headers, watchlist CRUD, and ticker lookup", async () => {
  clearMarketCaches();
  const db = new Database(":memory:");
  ensureSchema(db);
  ensureWebSchema(db);
  await findOrCreateUser(db, 5001);

  const botToken = "999999:WEB_TEST_TOKEN";
  const nowMs = Date.UTC(2026, 10, 27, 16, 0, 0);

  const mockFetch = ((url: string | URL | Request) => {
    const str = String(url);
    if (str.includes("/v1/finance/search")) {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            quotes: [{ symbol: "AAPL", shortname: "Apple Inc.", exchDisp: "NASDAQ", quoteType: "EQUITY" }],
          }),
          { status: 200 },
        ),
      );
    }
    if (str.includes("/v8/finance/chart/")) {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            chart: {
              result: [{
                meta: {
                  symbol: "AAPL",
                  shortName: "Apple Inc.",
                  exchangeName: "NMS",
                  instrumentType: "EQUITY",
                  currency: "USD",
                  exchangeTimezoneName: "America/New_York",
                  regularMarketPrice: 230.5,
                  previousClose: 228.0,
                  currentTradingPeriod: {
                    regular: {
                      start: Math.floor(nowMs / 1000) - 3600,
                      end: Math.floor(nowMs / 1000) + 3600,
                    },
                  },
                },
                timestamp: [Math.floor(nowMs / 1000) - 1800, Math.floor(nowMs / 1000) - 60],
                indicators: {
                  quote: [{
                    open: [228.5, 229.5],
                    high: [230.0, 231.0],
                    low: [228.0, 229.0],
                    close: [229.5, 230.5],
                    volume: [1_000_000, 1_200_000],
                  }],
                },
              }],
            },
          }),
          { status: 200 },
        ),
      );
    }
    return Promise.resolve(new Response("{}", { status: 404 }));
  }) as typeof fetch;

  const handler = createWebHttpHandler(db, {
    botToken,
    botUsername: "EyriTestBot",
    publicUrl: "https://eyri.mercat-pumpkinseed.ts.net",
    forcedUserId: null,
    request: mockFetch,
    now: () => nowMs,
  });

  // 1. Landing HTML has strict security headers
  const indexRes = await handler(new Request("https://eyri.mercat-pumpkinseed.ts.net/"));
  assertEquals(indexRes.status, 200);
  assertEquals(indexRes.headers.get("x-frame-options"), "DENY");
  assertEquals(indexRes.headers.get("x-content-type-options"), "nosniff");
  assert(indexRes.headers.get("content-security-policy")?.includes("https://telegram.org"));

  // 2. Magic-link endpoint does not exist (removed)
  const magicRes = await handler(
    new Request("https://eyri.mercat-pumpkinseed.ts.net/api/auth/magic", {
      method: "POST",
      headers: { Origin: "https://eyri.mercat-pumpkinseed.ts.net", "Content-Type": "application/json" },
      body: JSON.stringify({ token: "anything" }),
    }),
  );
  assertEquals(magicRes.status, 401);

  // 3. Protected API rejects unauthenticated access
  const unauthRes = await handler(new Request("https://eyri.mercat-pumpkinseed.ts.net/api/portfolio/overview"));
  assertEquals(unauthRes.status, 401);

  // 4. Telegram OAuth sign-in issues HttpOnly Secure cookie
  const payload = await signTelegram(
    { id: 5001, first_name: "Kit", username: "kitkat", auth_date: Math.floor(nowMs / 1000) - 5 },
    botToken,
  );
  const loginRes = await handler(
    new Request("https://eyri.mercat-pumpkinseed.ts.net/api/auth/telegram", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "https://eyri.mercat-pumpkinseed.ts.net",
      },
      body: JSON.stringify(payload),
    }),
  );
  assertEquals(loginRes.status, 200);
  const setCookie = loginRes.headers.get("set-cookie") ?? "";
  assert(setCookie.includes("eyri_session="));
  assert(setCookie.includes("HttpOnly"));
  assert(setCookie.includes("Secure"));
  const cookiePair = setCookie.split(";")[0];

  // Replay of same Telegram login payload is rejected
  const replayRes = await handler(
    new Request("https://eyri.mercat-pumpkinseed.ts.net/api/auth/telegram", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "https://eyri.mercat-pumpkinseed.ts.net",
      },
      body: JSON.stringify(payload),
    }),
  );
  assertEquals(replayRes.status, 401);

  // 5. Session endpoint returns logged-in user
  const sessRes = await handler(
    new Request("https://eyri.mercat-pumpkinseed.ts.net/api/auth/session", {
      headers: { Cookie: cookiePair },
    }),
  );
  const sessJson = await sessRes.json();
  assertEquals(sessJson.authenticated, true);
  assertEquals(sessJson.forced, false);
  assertEquals(sessJson.user.userId, 5001);

  // 6. Watchlist CRUD works and rejects cross-origin CSRF
  const csrfRes = await handler(
    new Request("https://eyri.mercat-pumpkinseed.ts.net/api/watchlist", {
      method: "POST",
      headers: {
        Cookie: cookiePair,
        Origin: "https://evil.example.com",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ symbol: "AAPL" }),
    }),
  );
  assertEquals(csrfRes.status, 403);

  const addRes = await handler(
    new Request("https://eyri.mercat-pumpkinseed.ts.net/api/watchlist", {
      method: "POST",
      headers: {
        Cookie: cookiePair,
        Origin: "https://eyri.mercat-pumpkinseed.ts.net",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ symbol: "aapl" }),
    }),
  );
  assertEquals(addRes.status, 201);
  const addJson = await addRes.json();
  assertEquals(addJson.watchlist.map((w: { symbol: string }) => w.symbol), ["AAPL"]);

  // 7. Ticker search & rich chart endpoints
  const searchRes = await handler(
    new Request("https://eyri.mercat-pumpkinseed.ts.net/api/tickers/search?q=aapl", {
      headers: { Cookie: cookiePair },
    }),
  );
  assertEquals(searchRes.status, 200);
  const searchJson = await searchRes.json();
  assertEquals(searchJson.results[0].symbol, "AAPL");

  const chartRes = await handler(
    new Request("https://eyri.mercat-pumpkinseed.ts.net/api/ticker/AAPL/chart?range=1d", {
      headers: { Cookie: cookiePair },
    }),
  );
  assertEquals(chartRes.status, 200);
  const chartJson = await chartRes.json();
  assertEquals(chartJson.chart.symbol, "AAPL");
  assertEquals(chartJson.chart.marketStatus.state, "REGULAR");

  // 8. Logout invalidates the session cookie
  const logoutRes = await handler(
    new Request("https://eyri.mercat-pumpkinseed.ts.net/api/auth/logout", {
      method: "POST",
      headers: { Cookie: cookiePair, Origin: "https://eyri.mercat-pumpkinseed.ts.net" },
    }),
  );
  assertEquals(logoutRes.status, 200);

  const afterLogout = await handler(
    new Request("https://eyri.mercat-pumpkinseed.ts.net/api/watchlist", {
      headers: { Cookie: cookiePair },
    }),
  );
  assertEquals(afterLogout.status, 401);

  db.close();
});

Deno.test("FORCE_USER authenticates local dev requests without Telegram OAuth", async () => {
  const db = new Database(":memory:");
  ensureSchema(db);
  ensureWebSchema(db);

  const handler = createWebHttpHandler(db, {
    forcedUserId: 77777,
    botUsername: "EyriTestBot",
  });

  const sessRes = await handler(new Request("http://127.0.0.1:3000/api/auth/session"));
  assertEquals(sessRes.status, 200);
  const sessJson = await sessRes.json();
  assertEquals(sessJson.authenticated, true);
  assertEquals(sessJson.forced, true);
  assertEquals(sessJson.user.userId, 77777);

  const overviewRes = await handler(new Request("http://127.0.0.1:3000/api/portfolio/overview"));
  assertEquals(overviewRes.status, 200);
  const overviewJson = await overviewRes.json();
  assertEquals(overviewJson.currency, "USD");

  db.close();
});

Deno.test("Persistent SQLite personal chart cache returns immediately and avoids blocking replay", async () => {
  const db = new Database(":memory:");
  ensureSchema(db);
  ensureWebSchema(db);
  await findOrCreateUser(db, 88888);
  // Register an integration so hasPortfolioViewIntegrations returns true.
  db.prepare("INSERT INTO integrations (user_id, kind, credentials_json) VALUES (?, ?, ?)").run(
    88888,
    "ibkr",
    JSON.stringify({ instanceUrl: "tcp://127.0.0.1:4003" }),
  );
  // Seed a fresh persisted chart snapshot in SQLite.
  db.prepare(
    "INSERT INTO web_personal_chart_cache (cache_key, user_id, dataset_json, updated_at) VALUES (?, ?, ?, ?)",
  ).run(
    "88888::alltime:all",
    88888,
    JSON.stringify({
      fundingReturnVersion: 6,
      kind: "alltime",
      userId: 88888,
      label: "Test",
      bucketName: null,
      benchmarkIndex: "sp500",
      points: [
        { date: "2026-01-02", gain: 100, percentage: 1.5 },
        { date: "2026-01-03", gain: 250, percentage: 3.75 },
      ],
      purchaseDates: ["2026-01-02"],
      notes: [],
    }),
    new Date().toISOString(),
  );

  const handler = createWebHttpHandler(db, {
    forcedUserId: 88888,
  });

  const t0 = performance.now();
  const res = await handler(new Request("http://127.0.0.1:3000/api/portfolio/chart?kind=alltime"));
  const elapsedMs = performance.now() - t0;
  assertEquals(res.status, 200);
  const json = await res.json();
  assertEquals(json.cached, true);
  assertEquals(json.points.length, 2);
  assertEquals(json.points[1].value, 250);
  assert(elapsedMs < 500, `Expected instant cached chart response, took ${elapsedMs}ms`);

  db.close();
});
