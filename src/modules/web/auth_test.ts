import { equal, ok as assertOk, throws } from "node:assert/strict";
import { Database } from "@db/sqlite";
import { ensureSchema } from "../database/setup.ts";
import { findOrCreateUser } from "../database/user.ts";
import {
  buildSessionCookie,
  consumeTelegramAuthReplay,
  createWebSession,
  ensureWebSchema,
  isSameOriginMutation,
  isUserAuthorized,
  parseAllowedUserIds,
  parseForcedUserId,
  readWebSession,
  revokeAllUserSessions,
  revokeWebSession,
  sha256Bytes,
  SlidingWindowRateLimiter,
  verifyTelegramLogin,
} from "./auth.ts";

async function signTelegramPayload(
  fields: Record<string, string | number>,
  botToken: string,
): Promise<Record<string, string | number>> {
  const dataCheckString = Object.entries(fields)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
  const secretKey = await sha256Bytes(botToken);
  const key = await crypto.subtle.importKey(
    "raw",
    secretKey as BufferSource,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(dataCheckString)),
  );
  const hash = [...sig].map((b) => b.toString(16).padStart(2, "0")).join("");
  return { ...fields, hash };
}

function makeDb() {
  const db = new Database(":memory:");
  ensureSchema(db);
  ensureWebSchema(db);
  return db;
}

Deno.test("Telegram OAuth verifies valid HMAC-SHA256 signature and rejects tampering/expiry/replay", async () => {
  const botToken = "123456:TEST_BOT_TOKEN_SECRET";
  const nowMs = Date.UTC(2026, 10, 27, 15, 0, 0);
  const authDate = Math.floor(nowMs / 1000) - 10;

  const signed = await signTelegramPayload(
    {
      id: 4242,
      first_name: "Ada",
      username: "ada_lovelace",
      auth_date: authDate,
    },
    botToken,
  );

  const verified = await verifyTelegramLogin(signed, botToken, nowMs);
  assertOk(verified.ok);
  equal(verified.payload.id, 4242);
  equal(verified.payload.username, "ada_lovelace");

  // Tampered field fails verification
  const tampered = await verifyTelegramLogin({ ...signed, id: 9999 }, botToken, nowMs);
  equal(tampered.ok, false);

  // Wrong bot token fails verification
  const wrongToken = await verifyTelegramLogin(signed, "999999:OTHER_TOKEN", nowMs);
  equal(wrongToken.ok, false);

  // Unexpected extra field is rejected
  const extraField = await verifyTelegramLogin({ ...signed, admin: "true" }, botToken, nowMs);
  equal(extraField.ok, false);

  // Expired auth_date is rejected
  const expired = await verifyTelegramLogin(signed, botToken, nowMs + 600_000);
  equal(expired.ok, false);

  // Future auth_date beyond skew is rejected
  const futureSigned = await signTelegramPayload(
    { id: 4242, auth_date: Math.floor(nowMs / 1000) + 300 },
    botToken,
  );
  const futureRes = await verifyTelegramLogin(futureSigned, botToken, nowMs);
  equal(futureRes.ok, false);

  // Replay protection allows once and blocks reuse
  const db = makeDb();
  equal(consumeTelegramAuthReplay(db, String(signed.hash), nowMs), true);
  equal(consumeTelegramAuthReplay(db, String(signed.hash), nowMs), false);
  db.close();
});

Deno.test("Sessions store only hashed tokens, honor expiration, and support revocation", async () => {
  const db = makeDb();
  await findOrCreateUser(db, 1001);
  const nowMs = Date.UTC(2026, 10, 27, 15, 0, 0);

  const { token, session } = await createWebSession(db, {
    userId: 1001,
    firstName: "Alice",
    username: "alice",
  }, nowMs);

  const stored = db.prepare("SELECT token_hash FROM web_sessions WHERE user_id = 1001").get() as {
    token_hash: string;
  };
  assertOk(stored.token_hash !== token);
  equal(stored.token_hash.length, 64);

  const loaded = await readWebSession(db, token, nowMs + 1_000);
  assertOk(loaded !== null);
  equal(loaded.userId, 1001);
  equal(loaded.sessionId, session.sessionId);

  await revokeWebSession(db, token);
  equal(await readWebSession(db, token, nowMs + 2_000), null);

  const s1 = await createWebSession(db, { userId: 1001 }, nowMs);
  const s2 = await createWebSession(db, { userId: 1001 }, nowMs);
  revokeAllUserSessions(db, 1001);
  equal(await readWebSession(db, s1.token, nowMs + 1_000), null);
  equal(await readWebSession(db, s2.token, nowMs + 1_000), null);

  const secCookie = buildSessionCookie("abc123", true);
  assertOk(secCookie.includes("HttpOnly"));
  assertOk(secCookie.includes("SameSite=Lax"));
  assertOk(secCookie.includes("Secure"));
  db.close();
});

Deno.test("FORCE_USER parser validates positive integer IDs and rejects garbage", () => {
  equal(parseForcedUserId(undefined), null);
  equal(parseForcedUserId("   "), null);
  equal(parseForcedUserId("278204147"), 278204147);
  throws(() => parseForcedUserId("abc"));
  throws(() => parseForcedUserId("0"));
  throws(() => parseForcedUserId("-5"));
});

Deno.test("Authorization, origin checks, and rate limiter enforce security boundaries", async () => {
  const db = makeDb();
  await findOrCreateUser(db, 111);
  const allowlist = parseAllowedUserIds("111, 222");

  equal(isUserAuthorized(db, 111, allowlist).ok, true);
  equal(isUserAuthorized(db, 222, allowlist).ok, false);
  await findOrCreateUser(db, 333);
  equal(isUserAuthorized(db, 333, allowlist).ok, false);

  const sameOriginReq = new Request("https://eyri.example.com/api/watchlist", {
    method: "POST",
    headers: { Origin: "https://eyri.example.com", "Sec-Fetch-Site": "same-origin" },
  });
  equal(isSameOriginMutation(sameOriginReq, "https://eyri.example.com"), true);

  const crossOriginReq = new Request("https://eyri.example.com/api/watchlist", {
    method: "POST",
    headers: { Origin: "https://evil.example.com", "Sec-Fetch-Site": "cross-site" },
  });
  equal(isSameOriginMutation(crossOriginReq, "https://eyri.example.com"), false);

  const limiter = new SlidingWindowRateLimiter(2, 60_000);
  equal(limiter.allow("ip1", 1000), true);
  equal(limiter.allow("ip1", 2000), true);
  equal(limiter.allow("ip1", 3000), false);
  equal(limiter.allow("ip1", 62_000), true);
  db.close();
});
