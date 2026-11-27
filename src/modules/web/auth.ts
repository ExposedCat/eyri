import type { Database } from "../database/setup.ts";
import { readUser } from "../database/user.ts";

export const SESSION_COOKIE_NAME = "eyri_session";
export const TELEGRAM_AUTH_MAX_AGE_SECONDS = 300;
export const TELEGRAM_AUTH_FUTURE_SKEW_SECONDS = 60;
export const SESSION_TTL_MS = 14 * 24 * 60 * 60 * 1000;

export type TelegramLoginPayload = {
  id: number;
  first_name?: string;
  last_name?: string;
  username?: string;
  photo_url?: string;
  auth_date: number;
  hash: string;
};

export type WebSessionUser = {
  sessionId: string;
  userId: number;
  firstName: string | null;
  lastName: string | null;
  username: string | null;
  photoUrl: string | null;
  createdAt: number;
  expiresAt: number;
  forced?: boolean;
};

type SessionRow = {
  token_hash: string;
  user_id: number;
  first_name: string | null;
  last_name: string | null;
  username: string | null;
  photo_url: string | null;
  created_at: string;
  expires_at: string;
};

const toIso = (ms: number) => new Date(ms).toISOString();

export function ensureWebSchema(db: Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS web_sessions (
      token_hash TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
      first_name TEXT,
      last_name TEXT,
      username TEXT,
      photo_url TEXT,
      created_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS web_sessions_user_id_idx
      ON web_sessions(user_id);

    CREATE INDEX IF NOT EXISTS web_sessions_expires_at_idx
      ON web_sessions(expires_at);

    CREATE TABLE IF NOT EXISTS web_auth_replays (
      hash TEXT PRIMARY KEY,
      expires_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS web_watchlist (
      user_id INTEGER NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
      symbol TEXT NOT NULL,
      added_at TEXT NOT NULL,
      PRIMARY KEY (user_id, symbol)
    );

    CREATE INDEX IF NOT EXISTS web_watchlist_user_added_idx
      ON web_watchlist(user_id, added_at);

    CREATE TABLE IF NOT EXISTS web_personal_chart_cache (
      cache_key TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
      dataset_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS web_personal_chart_cache_user_idx
      ON web_personal_chart_cache(user_id);
  `);
}

function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i].toString(16).padStart(2, "0");
  }
  return out;
}

function hexToBytes(hex: string): Uint8Array | null {
  if (hex.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(hex)) return null;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

export function timingSafeEqualBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a[i] ^ b[i];
  }
  return diff === 0;
}

export async function sha256Bytes(value: string): Promise<Uint8Array> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return new Uint8Array(digest);
}

export async function sha256Hex(value: string): Promise<string> {
  return bytesToHex(await sha256Bytes(value));
}

export function randomToken(byteLength = 32): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

export function parseForcedUserId(raw: string | undefined): number | null {
  if (!raw || !raw.trim()) return null;
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) {
    throw new Error(`Invalid FORCE_USER value "${trimmed}": must be a positive integer Telegram user ID.`);
  }
  const id = Number(trimmed);
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new Error(`Invalid FORCE_USER value "${trimmed}": must be a positive integer Telegram user ID.`);
  }
  return id;
}

export function parseAllowedUserIds(raw: string | undefined): Set<number> | null {
  if (!raw || !raw.trim()) return null;
  const ids = new Set<number>();
  for (const part of raw.split(",")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const id = Number(trimmed);
    if (!Number.isSafeInteger(id) || id <= 0) {
      throw new Error(`Invalid Telegram user ID in EYRI_WEB_ALLOWED_USERS: ${trimmed}`);
    }
    ids.add(id);
  }
  return ids.size ? ids : null;
}

export function isUserAuthorized(
  db: Database,
  userId: number,
  allowedUserIds?: Set<number> | null,
): { ok: true } | { ok: false; reason: string } {
  if (!Number.isSafeInteger(userId) || userId <= 0) {
    return { ok: false, reason: "Invalid Telegram user ID." };
  }
  if (allowedUserIds && !allowedUserIds.has(userId)) {
    return { ok: false, reason: "This Telegram account is not authorized to access Eyri." };
  }
  const existing = readUser(db, userId);
  if (!existing) {
    return {
      ok: false,
      reason: "Account not found. Start a chat with the Eyri Telegram bot using /start first.",
    };
  }
  return { ok: true };
}

const ALLOWED_TELEGRAM_FIELDS = new Set([
  "id",
  "first_name",
  "last_name",
  "username",
  "photo_url",
  "auth_date",
]);

export function parseTelegramLoginPayload(
  raw: Record<string, unknown>,
): TelegramLoginPayload | null {
  const id = typeof raw.id === "number"
    ? raw.id
    : typeof raw.id === "string" && /^\d+$/.test(raw.id)
    ? Number(raw.id)
    : Number.NaN;
  const authDate = typeof raw.auth_date === "number"
    ? raw.auth_date
    : typeof raw.auth_date === "string" && /^\d+$/.test(raw.auth_date)
    ? Number(raw.auth_date)
    : Number.NaN;
  const hash = typeof raw.hash === "string" ? raw.hash.trim().toLowerCase() : "";

  if (!Number.isSafeInteger(id) || id <= 0) return null;
  if (!Number.isSafeInteger(authDate) || authDate <= 0) return null;
  if (!/^[0-9a-f]{64}$/.test(hash)) return null;

  const optionalString = (value: unknown, maxLen: number): string | undefined => {
    if (value === undefined || value === null || value === "") return undefined;
    if (typeof value !== "string") return undefined;
    return value.length <= maxLen ? value : undefined;
  };

  const photoUrl = optionalString(raw.photo_url, 1024);
  if (photoUrl !== undefined) {
    try {
      const parsed = new URL(photoUrl);
      if (parsed.protocol !== "https:") return null;
    } catch {
      return null;
    }
  }

  return {
    id,
    auth_date: authDate,
    hash,
    ...(optionalString(raw.first_name, 128) !== undefined
      ? { first_name: optionalString(raw.first_name, 128) }
      : {}),
    ...(optionalString(raw.last_name, 128) !== undefined
      ? { last_name: optionalString(raw.last_name, 128) }
      : {}),
    ...(optionalString(raw.username, 64) !== undefined
      ? { username: optionalString(raw.username, 64) }
      : {}),
    ...(photoUrl !== undefined ? { photo_url: photoUrl } : {}),
  };
}

export async function verifyTelegramLogin(
  raw: Record<string, unknown>,
  botToken: string,
  nowMs = Date.now(),
  maxAgeSeconds = TELEGRAM_AUTH_MAX_AGE_SECONDS,
): Promise<{ ok: true; payload: TelegramLoginPayload } | { ok: false; error: string }> {
  if (!botToken) {
    return { ok: false, error: "Telegram bot token is not configured." };
  }
  const payload = parseTelegramLoginPayload(raw);
  if (!payload) {
    return { ok: false, error: "Malformed Telegram authentication payload." };
  }

  const nowSeconds = Math.floor(nowMs / 1000);
  if (payload.auth_date > nowSeconds + TELEGRAM_AUTH_FUTURE_SKEW_SECONDS) {
    return { ok: false, error: "Telegram auth timestamp is in the future." };
  }
  if (nowSeconds - payload.auth_date > maxAgeSeconds) {
    return { ok: false, error: "Telegram login payload has expired. Please sign in again." };
  }

  const entries: [string, string][] = [];
  for (const [key, value] of Object.entries(raw)) {
    if (key === "hash") continue;
    if (!ALLOWED_TELEGRAM_FIELDS.has(key)) {
      return { ok: false, error: `Unexpected Telegram auth field: ${key}` };
    }
    if (value === undefined || value === null || value === "") continue;
    entries.push([key, String(value)]);
  }
  entries.sort(([a], [b]) => a.localeCompare(b));
  const dataCheckString = entries.map(([k, v]) => `${k}=${v}`).join("\n");

  const secretKeyBytes = await sha256Bytes(botToken);
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    secretKeyBytes as BufferSource,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = new Uint8Array(
    await crypto.subtle.sign(
      "HMAC",
      cryptoKey,
      new TextEncoder().encode(dataCheckString),
    ),
  );
  const providedBytes = hexToBytes(payload.hash);
  if (!providedBytes || !timingSafeEqualBytes(signature, providedBytes)) {
    return { ok: false, error: "Invalid Telegram authentication signature." };
  }

  return { ok: true, payload };
}

export function consumeTelegramAuthReplay(
  db: Database,
  hash: string,
  nowMs = Date.now(),
  maxAgeSeconds = TELEGRAM_AUTH_MAX_AGE_SECONDS,
): boolean {
  ensureWebSchema(db);
  db.prepare("DELETE FROM web_auth_replays WHERE expires_at <= ?").run(toIso(nowMs));
  const expiresAt = nowMs + (maxAgeSeconds + TELEGRAM_AUTH_FUTURE_SKEW_SECONDS) * 1000;
  const result = db
    .prepare("INSERT OR IGNORE INTO web_auth_replays (hash, expires_at) VALUES (?, ?)")
    .run(hash, toIso(expiresAt));
  return result > 0;
}

export async function createWebSession(
  db: Database,
  profile: {
    userId: number;
    firstName?: string | null;
    lastName?: string | null;
    username?: string | null;
    photoUrl?: string | null;
  },
  nowMs = Date.now(),
): Promise<{ token: string; session: WebSessionUser }> {
  ensureWebSchema(db);
  const token = randomToken(32);
  const tokenHash = await sha256Hex(token);
  const expiresAt = nowMs + SESSION_TTL_MS;
  const nowIso = toIso(nowMs);
  db.prepare(`
    INSERT INTO web_sessions (
      token_hash, user_id, first_name, last_name, username, photo_url,
      created_at, last_seen_at, expires_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    tokenHash,
    profile.userId,
    profile.firstName ?? null,
    profile.lastName ?? null,
    profile.username ?? null,
    profile.photoUrl ?? null,
    nowIso,
    nowIso,
    toIso(expiresAt),
  );
  return {
    token,
    session: {
      sessionId: tokenHash.slice(0, 12),
      userId: profile.userId,
      firstName: profile.firstName ?? null,
      lastName: profile.lastName ?? null,
      username: profile.username ?? null,
      photoUrl: profile.photoUrl ?? null,
      createdAt: nowMs,
      expiresAt,
    },
  };
}

export async function readWebSession(
  db: Database,
  token: string,
  nowMs = Date.now(),
): Promise<WebSessionUser | null> {
  if (!token || token.length < 20 || token.length > 256) return null;
  ensureWebSchema(db);
  const tokenHash = await sha256Hex(token);
  const row = db
    .prepare(
      `SELECT token_hash, user_id, first_name, last_name, username, photo_url, created_at, expires_at
       FROM web_sessions WHERE token_hash = ?`,
    )
    .get(tokenHash) as SessionRow | undefined;
  if (!row) return null;
  let expiresAt = Date.parse(row.expires_at);
  const createdAt = Date.parse(row.created_at);
  if (!Number.isFinite(expiresAt) || expiresAt <= nowMs) {
    db.prepare("DELETE FROM web_sessions WHERE token_hash = ?").run(tokenHash);
    return null;
  }
  const nextExpiry = nowMs + SESSION_TTL_MS;
  if (nextExpiry - expiresAt > 24 * 60 * 60 * 1000) {
    db.prepare("UPDATE web_sessions SET last_seen_at = ?, expires_at = ? WHERE token_hash = ?")
      .run(toIso(nowMs), toIso(nextExpiry), tokenHash);
    expiresAt = nextExpiry;
  }
  return {
    sessionId: row.token_hash.slice(0, 12),
    userId: row.user_id,
    firstName: row.first_name,
    lastName: row.last_name,
    username: row.username,
    photoUrl: row.photo_url,
    createdAt,
    expiresAt,
  };
}

export async function revokeWebSession(db: Database, token: string): Promise<void> {
  if (!token) return;
  ensureWebSchema(db);
  const tokenHash = await sha256Hex(token);
  db.prepare("DELETE FROM web_sessions WHERE token_hash = ?").run(tokenHash);
}

export function revokeAllUserSessions(db: Database, userId: number): void {
  ensureWebSchema(db);
  db.prepare("DELETE FROM web_sessions WHERE user_id = ?").run(userId);
}

export function parseCookieHeader(header: string | null): Map<string, string> {
  const map = new Map<string, string>();
  if (!header) return map;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx <= 0) continue;
    const key = part.slice(0, idx).trim();
    const val = part.slice(idx + 1).trim();
    if (key) map.set(key, decodeURIComponent(val));
  }
  return map;
}

export function isSecureRequest(request: Request, publicUrl?: string): boolean {
  if (publicUrl?.startsWith("https://")) return true;
  const proto = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim().toLowerCase();
  if (proto === "https") return true;
  return new URL(request.url).protocol === "https:";
}

export function buildSessionCookie(
  token: string,
  secure: boolean,
  maxAgeSeconds = Math.floor(SESSION_TTL_MS / 1000),
): string {
  const parts = [
    `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${maxAgeSeconds}`,
  ];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

export function buildClearSessionCookie(secure: boolean): string {
  const parts = [
    `${SESSION_COOKIE_NAME}=`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    "Max-Age=0",
  ];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

export function isSameOriginMutation(request: Request, publicUrl?: string): boolean {
  const secFetchSite = request.headers.get("sec-fetch-site");
  if (secFetchSite && secFetchSite !== "same-origin" && secFetchSite !== "none") {
    return false;
  }
  const origin = request.headers.get("origin");
  if (!origin) return true;
  const url = new URL(request.url);
  const allowedOrigins = new Set<string>([url.origin]);
  if (publicUrl) {
    try {
      allowedOrigins.add(new URL(publicUrl).origin);
    } catch {
      // ignore invalid publicUrl
    }
  }
  const forwardedHost = request.headers.get("x-forwarded-host")?.split(",")[0]?.trim();
  const forwardedProto = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim() ||
    url.protocol.replace(":", "");
  if (forwardedHost) {
    allowedOrigins.add(`${forwardedProto}://${forwardedHost}`);
  }
  return allowedOrigins.has(origin);
}

export class SlidingWindowRateLimiter {
  private hits = new Map<string, number[]>();
  constructor(
    private readonly maxRequests: number,
    private readonly windowMs: number,
  ) {}

  allow(key: string, nowMs = Date.now()): boolean {
    const cutoff = nowMs - this.windowMs;
    const recent = (this.hits.get(key) ?? []).filter((ts) => ts > cutoff);
    if (recent.length >= this.maxRequests) {
      this.hits.set(key, recent);
      return false;
    }
    recent.push(nowMs);
    this.hits.set(key, recent);
    if (this.hits.size > 1000) {
      for (const [k, list] of this.hits) {
        if (!list.some((ts) => ts > cutoff)) this.hits.delete(k);
      }
    }
    return true;
  }
}
