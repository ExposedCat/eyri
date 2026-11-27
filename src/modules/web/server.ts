import type { Database } from "../database/setup.ts";
import { getUserIntegrations, type Integration } from "../database/integration.ts";
import { gatewayMonitor } from "../integrations/ibkr/gateway.ts";
import { gatewayRecovery, getRestartContainerName } from "../integrations/ibkr/recovery.ts";
import { findOrCreateUser } from "../database/user.ts";
import type { ReportRuntime } from "../mcp/reports.ts";
import type { ReportFilter } from "../tickers/performance_command.ts";
import {
  buildClearSessionCookie,
  buildSessionCookie,
  consumeTelegramAuthReplay,
  createWebSession,
  ensureWebSchema,
  isSameOriginMutation,
  isSecureRequest,
  isUserAuthorized,
  parseAllowedUserIds,
  parseCookieHeader,
  parseForcedUserId,
  readWebSession,
  revokeAllUserSessions,
  revokeWebSession,
  SESSION_COOKIE_NAME,
  SlidingWindowRateLimiter,
  verifyTelegramLogin,
  type WebSessionUser,
} from "./auth.ts";
import {
  fetchTickerChart,
  fetchTickerSnapshots,
  isValidTickerRange,
  sanitizeSymbol,
  searchTickers,
  type TickerRange,
} from "./market.ts";
import {
  fetchTickerChartViaIbkr,
  fetchTickerSnapshotsViaIbkr,
  searchTickersViaIbkr,
} from "./ibkr_market.ts";
import {
  addWatchlistSymbol,
  listWatchlist,
  loadUserTickerContext,
  loadWebOverview,
  loadWebPersonalChart,
  removeWatchlistSymbol,
  type WebBenchmarkOption,
  type WebPersonalChartKind,
} from "./portfolio.ts";

export type WebServerOptions = {
  botToken?: string;
  botUsername?: string | null;
  publicUrl?: string;
  allowedUserIds?: Set<number> | null;
  forcedUserId?: number | null;
  request?: typeof fetch;
  reportRuntime?: ReportRuntime;
  now?: () => number;
};

const ASSETS = {
  html: await Deno.readTextFile(new URL("./assets/index.html", import.meta.url)),
  css: await Deno.readTextFile(new URL("./assets/styles.css", import.meta.url)),
  chartsJs: await Deno.readTextFile(new URL("./assets/charts.js", import.meta.url)),
  appJs: await Deno.readTextFile(new URL("./assets/app.js", import.meta.url)),
};

const CSP_HEADER = [
  "default-src 'self'",
  "script-src 'self' https://telegram.org",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' https: data:",
  "connect-src 'self'",
  "frame-src https://oauth.telegram.org",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join("; ");

function applySecurityHeaders(headers: Headers) {
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("X-Frame-Options", "DENY");
  headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  headers.set("Content-Security-Policy", CSP_HEADER);
}

function jsonResponse(
  body: unknown,
  init: { status?: number; headers?: Record<string, string>; cacheControl?: string } = {},
): Response {
  const headers = new Headers(init.headers);
  headers.set("Content-Type", "application/json; charset=utf-8");
  headers.set("Cache-Control", init.cacheControl ?? "no-store");
  applySecurityHeaders(headers);
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers,
  });
}

function textResponse(
  body: string,
  contentType: string,
  cacheControl = "no-cache",
): Response {
  const headers = new Headers({
    "Content-Type": contentType,
    "Cache-Control": cacheControl,
  });
  applySecurityHeaders(headers);
  return new Response(body, { status: 200, headers });
}

function clientRateKey(request: Request): string {
  const fwd = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  const realIp = request.headers.get("x-real-ip")?.trim();
  return fwd || realIp || "local";
}

function parseFilterParam(raw: string | null): ReportFilter | undefined {
  if (raw === "stocks" || raw === "options") return raw;
  return undefined;
}

function parseBucketParam(raw: string | null): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed || !/^[A-Za-z][A-Za-z0-9_]{0,19}$/.test(trimmed)) return null;
  return trimmed;
}

function parsePersonalKind(raw: string | null): WebPersonalChartKind {
  if (raw === "perf" || raw === "worth" || raw === "alltime") return raw;
  return "alltime";
}

function parseBenchmark(raw: string | null): WebBenchmarkOption {
  if (raw === "none" || raw === "sp500" || raw === "momentum" || raw === "spyl") return raw;
  return "sp500";
}

async function readJsonBody(request: Request): Promise<Record<string, unknown> | null> {
  const lengthHeader = request.headers.get("content-length");
  if (lengthHeader && Number(lengthHeader) > 32_768) return null;
  try {
    const raw = await request.text();
    if (raw.length > 32_768) return null;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

export function createWebHttpHandler(
  db: Database,
  options: WebServerOptions = {},
) {
  ensureWebSchema(db);
  const botToken = options.botToken ?? Deno.env.get("TOKEN") ?? "";
  const botUsername = (options.botUsername ?? Deno.env.get("EYRI_WEB_BOT_USERNAME") ?? "")
    .replace(/^@/, "")
    .trim() || null;
  const publicUrl = options.publicUrl ?? Deno.env.get("EYRI_WEB_URL") ?? undefined;
  const allowedUserIds = options.allowedUserIds !== undefined
    ? options.allowedUserIds
    : parseAllowedUserIds(Deno.env.get("EYRI_WEB_ALLOWED_USERS"));
  const forcedUserId = options.forcedUserId !== undefined
    ? options.forcedUserId
    : parseForcedUserId(Deno.env.get("FORCE_USER"));
  const fetcher = options.request ?? fetch;
  const now = options.now ?? Date.now;
  const authLimiter = new SlidingWindowRateLimiter(15, 60_000);

  if (forcedUserId !== null) {
    console.warn(
      `[Eyri Web] FORCE_USER=${forcedUserId} is active — Telegram OAuth is bypassed for local testing.`,
    );
  }

  async function resolveSession(request: Request): Promise<{ token: string; user: WebSessionUser } | null> {
    if (forcedUserId !== null) {
      await findOrCreateUser(db, forcedUserId);
      const ts = now();
      return {
        token: "forced",
        user: {
          sessionId: "forced",
          userId: forcedUserId,
          firstName: `User ${forcedUserId}`,
          lastName: null,
          username: null,
          photoUrl: null,
          createdAt: ts,
          expiresAt: ts + 86_400_000,
          forced: true,
        },
      };
    }

    const cookies = parseCookieHeader(request.headers.get("cookie"));
    const token = cookies.get(SESSION_COOKIE_NAME);
    if (!token) return null;
    const user = await readWebSession(db, token, now());
    if (!user) return null;
    const authz = isUserAuthorized(db, user.userId, allowedUserIds);
    if (!authz.ok) {
      await revokeWebSession(db, token);
      return null;
    }
    return { token, user };
  }

  const restartProgress = new Map<string, { at: number; message: string; done: boolean }>();

  function userIbkrGateways(userId: number): { host: string; integration: Integration }[] {
    const seen = new Map<string, Integration>();
    for (const integration of getUserIntegrations(db, userId)) {
      if (integration.kind !== "ibkr") continue;
      try {
        const host = getRestartContainerName(integration.credentials);
        if (!seen.has(host)) seen.set(host, integration);
      } catch {
        // Integration without an instance URL; nothing to monitor.
      }
    }
    return [...seen].map(([host, integration]) => ({ host, integration }));
  }

  async function signInWithTelegram(
    request: Request,
    raw: Record<string, unknown>,
  ): Promise<
    | { ok: true; cookie: string; user: Pick<WebSessionUser, "userId" | "firstName" | "lastName" | "username" | "photoUrl"> }
    | { ok: false; status: number; error: string }
  > {
    if (!authLimiter.allow(`tg:${clientRateKey(request)}`, now())) {
      return { ok: false, status: 429, error: "Too many sign-in attempts. Wait a minute and try again." };
    }
    const verified = await verifyTelegramLogin(raw, botToken, now());
    if (!verified.ok) return { ok: false, status: 401, error: verified.error };
    if (!consumeTelegramAuthReplay(db, verified.payload.hash, now())) {
      return { ok: false, status: 401, error: "This Telegram login payload was already used. Sign in again." };
    }
    const authz = isUserAuthorized(db, verified.payload.id, allowedUserIds);
    if (!authz.ok) return { ok: false, status: 403, error: authz.reason };
    const { token, session } = await createWebSession(db, {
      userId: verified.payload.id,
      firstName: verified.payload.first_name ?? null,
      lastName: verified.payload.last_name ?? null,
      username: verified.payload.username ?? null,
      photoUrl: verified.payload.photo_url ?? null,
    }, now());
    return {
      ok: true,
      cookie: buildSessionCookie(token, isSecureRequest(request, publicUrl)),
      user: {
        userId: session.userId,
        firstName: session.firstName,
        lastName: session.lastName,
        username: session.username,
        photoUrl: session.photoUrl,
      },
    };
  }

  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const { pathname } = url;
    const method = request.method.toUpperCase();

    if (method === "GET" && pathname === "/health") {
      return jsonResponse({ ok: true });
    }

    if (method === "GET" && (pathname === "/" || pathname === "/index.html")) {
      return textResponse(ASSETS.html, "text/html; charset=utf-8", "no-cache");
    }
    if (method === "GET" && pathname === "/assets/styles.css") {
      return textResponse(ASSETS.css, "text/css; charset=utf-8", "no-cache");
    }
    if (method === "GET" && pathname === "/assets/charts.js") {
      return textResponse(ASSETS.chartsJs, "application/javascript; charset=utf-8", "no-cache");
    }
    if (method === "GET" && pathname === "/assets/app.js") {
      return textResponse(ASSETS.appJs, "application/javascript; charset=utf-8", "no-cache");
    }

    if (method === "GET" && pathname === "/api/auth/session") {
      const resolved = await resolveSession(request);
      if (!resolved) {
        return jsonResponse({
          authenticated: false,
          forced: false,
          botUsername,
        });
      }
      return jsonResponse({
        authenticated: true,
        forced: Boolean(resolved.user.forced),
        botUsername,
        user: {
          userId: resolved.user.userId,
          firstName: resolved.user.firstName,
          lastName: resolved.user.lastName,
          username: resolved.user.username,
          photoUrl: resolved.user.photoUrl,
        },
      });
    }

    if (method === "POST" && pathname === "/api/auth/telegram") {
      if (!isSameOriginMutation(request, publicUrl)) {
        return jsonResponse({ error: "Invalid request origin." }, { status: 403 });
      }
      const body = await readJsonBody(request);
      if (!body) {
        return jsonResponse({ error: "Invalid JSON payload." }, { status: 400 });
      }
      const result = await signInWithTelegram(request, body);
      if (!result.ok) {
        return jsonResponse({ error: result.error }, { status: result.status });
      }
      return jsonResponse(
        { authenticated: true, forced: false, user: result.user },
        { headers: { "Set-Cookie": result.cookie } },
      );
    }

    // Redirect flow for the Telegram Login Widget (data-auth-url). Avoids the widget's
    // eval()-based data-onauth callback, which the CSP (no 'unsafe-eval') blocks.
    if (method === "GET" && pathname === "/auth/telegram/callback") {
      const fail = (error: string) =>
        new Response(null, {
          status: 303,
          headers: { Location: `/?login_error=${encodeURIComponent(error)}`, "Cache-Control": "no-store" },
        });
      if (!isSameOriginMutation(request, publicUrl)) {
        return fail("Invalid request origin.");
      }
      const payload: Record<string, string> = {};
      for (const [key, value] of url.searchParams) payload[key] = value;
      const result = await signInWithTelegram(request, payload);
      if (!result.ok) return fail(result.error);
      return new Response(null, {
        status: 303,
        headers: { Location: "/", "Set-Cookie": result.cookie, "Cache-Control": "no-store" },
      });
    }

    if (method === "POST" && pathname === "/api/auth/logout") {
      if (!isSameOriginMutation(request, publicUrl)) {
        return jsonResponse({ error: "Invalid request origin." }, { status: 403 });
      }
      const resolved = await resolveSession(request);
      if (resolved && !resolved.user.forced) {
        const body = await readJsonBody(request);
        if (body?.all === true) {
          revokeAllUserSessions(db, resolved.user.userId);
        } else {
          await revokeWebSession(db, resolved.token);
        }
      }
      const clear = buildClearSessionCookie(isSecureRequest(request, publicUrl));
      return jsonResponse({ ok: true }, { headers: { "Set-Cookie": clear } });
    }

    if (pathname.startsWith("/api/")) {
      const resolved = await resolveSession(request);
      if (!resolved) {
        return jsonResponse({ error: "Authentication required." }, { status: 401 });
      }
      const userId = resolved.user.userId;

      if (["POST", "PUT", "PATCH", "DELETE"].includes(method)) {
        if (!isSameOriginMutation(request, publicUrl)) {
          return jsonResponse({ error: "Invalid request origin." }, { status: 403 });
        }
      }

      try {
        if (method === "GET" && pathname === "/api/portfolio/overview") {
          const bucketName = parseBucketParam(url.searchParams.get("bucket"));
          const filter = parseFilterParam(url.searchParams.get("filter"));
          const refresh = url.searchParams.get("refresh") === "1";
          const overview = await loadWebOverview(db, userId, {
            bucketName,
            filter,
            refresh,
            runtime: options.reportRuntime,
          });
          return jsonResponse(overview);
        }

        if (method === "GET" && pathname === "/api/portfolio/chart") {
          const kind = parsePersonalKind(url.searchParams.get("kind"));
          const filter = parseFilterParam(url.searchParams.get("filter"));
          const bucketName = parseBucketParam(url.searchParams.get("bucket"));
          const benchmark = parseBenchmark(url.searchParams.get("benchmark"));
          const refresh = url.searchParams.get("refresh") === "1";
          const chart = await loadWebPersonalChart(db, userId, {
            kind,
            filter,
            bucketName,
            benchmark,
            refresh,
            request: fetcher,
            viewLoader: options.reportRuntime?.view,
            datasetLoader: options.reportRuntime?.chart,
          });
          return jsonResponse(chart);
        }

        if (method === "GET" && pathname === "/api/tickers/search") {
          const query = url.searchParams.get("q") ?? "";
          let results = null;
          try {
            results = await searchTickersViaIbkr(db, userId, query, now());
          } catch (err) {
            console.warn(`IBKR search fallback to Yahoo for "${query}":`, err);
          }
          if (!results || !results.length) {
            results = await searchTickers(query, fetcher, now());
          }
          return jsonResponse({ results });
        }

        if (method === "GET" && pathname === "/api/tickers/snapshots") {
          const raw = url.searchParams.get("symbols") ?? "";
          const symbols = raw.split(",").map((s) => s.trim()).filter(Boolean);
          let ibMap: Map<string, Awaited<ReturnType<typeof fetchTickerSnapshots>>[number]> | null = null;
          try {
            ibMap = await fetchTickerSnapshotsViaIbkr(db, userId, symbols, now());
          } catch (err) {
            console.warn("IBKR snapshots fallback to Yahoo:", err);
          }
          const missing = symbols.filter((s) => !ibMap?.has(s.toUpperCase()));
          const fallbackList = missing.length ? await fetchTickerSnapshots(missing, fetcher, now()) : [];
          const fallbackMap = new Map(fallbackList.map((s) => [s.symbol.toUpperCase(), s]));
          const snapshots = symbols
            .map((s) => s.toUpperCase())
            .map((sym) => ibMap?.get(sym) ?? fallbackMap.get(sym))
            .filter((s): s is NonNullable<typeof s> => Boolean(s));
          return jsonResponse({ snapshots });
        }

        const tickerChartMatch = pathname.match(/^\/api\/ticker\/([^/]+)\/chart$/);
        if (method === "GET" && tickerChartMatch) {
          const symbol = sanitizeSymbol(decodeURIComponent(tickerChartMatch[1]));
          if (!symbol) {
            return jsonResponse({ error: "Invalid ticker symbol." }, { status: 400 });
          }
          const rangeParam = (url.searchParams.get("range") ?? "1d").toLowerCase();
          const range: TickerRange = isValidTickerRange(rangeParam) ? rangeParam : "1d";
          const loadChart = async () => {
            try {
              const ibChart = await fetchTickerChartViaIbkr(db, userId, symbol, range, now());
              if (ibChart && ibChart.bars.length) return ibChart;
            } catch (err) {
              console.warn(`IBKR chart fallback to Yahoo for ${symbol} (${range}):`, err);
            }
            return await fetchTickerChart(symbol, range, fetcher, now());
          };
          // context=0 lets the client fetch the chart without waiting on the portfolio-derived
          // position context (loaded separately via /context).
          if (url.searchParams.get("context") === "0") {
            return jsonResponse({ chart: await loadChart() });
          }
          const [chart, userContext] = await Promise.all([
            loadChart(),
            loadUserTickerContext(db, userId, symbol, options.reportRuntime),
          ]);
          return jsonResponse({ chart, userContext });
        }

        const tickerContextMatch = pathname.match(/^\/api\/ticker\/([^/]+)\/context$/);
        if (method === "GET" && tickerContextMatch) {
          const symbol = sanitizeSymbol(decodeURIComponent(tickerContextMatch[1]));
          if (!symbol) {
            return jsonResponse({ error: "Invalid ticker symbol." }, { status: 400 });
          }
          const userContext = await loadUserTickerContext(db, userId, symbol, options.reportRuntime);
          return jsonResponse({ userContext });
        }

        if (method === "GET" && pathname === "/api/brokers/status") {
          const brokers = await Promise.all(
            userIbkrGateways(userId).map(async ({ host }) => {
              const health = await gatewayMonitor.read(host);
              const restart = restartProgress.get(host);
              return {
                kind: "ibkr",
                host,
                state: health.state,
                reason: health.reason ?? null,
                message: health.message,
                restart: restart && now() - restart.at < 15 * 60_000 ? restart : null,
              };
            }),
          );
          return jsonResponse({ brokers }, { cacheControl: "no-store" });
        }

        if (method === "POST" && pathname === "/api/brokers/restart") {
          const body = await readJsonBody(request);
          const host = typeof body?.host === "string" ? body.host : "";
          const gateway = userIbkrGateways(userId).find((g) => g.host === host);
          if (!gateway) {
            return jsonResponse({ error: "Unknown IB Gateway." }, { status: 404 });
          }
          if (!authLimiter.allow(`restart:${userId}`, now())) {
            return jsonResponse({ error: "Too many restarts. Wait a minute." }, { status: 429 });
          }
          const update = (message: string, ready?: boolean) => {
            restartProgress.set(host, { at: now(), message, done: ready === true });
          };
          update("Restart requested…");
          void gatewayRecovery.restartAndFollow(gateway.integration, update).catch((error) => {
            console.warn(`[Eyri Web] Gateway restart for ${host} failed:`, error);
            update(error instanceof Error && "userMessage" in error
              ? String((error as { userMessage: unknown }).userMessage)
              : "Gateway restart failed. Ask admin to check it.");
          });
          return jsonResponse({ ok: true }, { status: 202 });
        }

        if (method === "GET" && pathname === "/api/watchlist") {
          return jsonResponse({ watchlist: listWatchlist(db, userId) });
        }

        if (method === "POST" && pathname === "/api/watchlist") {
          const body = await readJsonBody(request);
          const symbol = typeof body?.symbol === "string" ? body.symbol : "";
          const added = addWatchlistSymbol(db, userId, symbol, now());
          return jsonResponse({ added, watchlist: listWatchlist(db, userId) }, { status: 201 });
        }

        const watchDeleteMatch = pathname.match(/^\/api\/watchlist\/([^/]+)$/);
        if (method === "DELETE" && watchDeleteMatch) {
          const symbol = decodeURIComponent(watchDeleteMatch[1]);
          removeWatchlistSymbol(db, userId, symbol);
          return jsonResponse({ watchlist: listWatchlist(db, userId) });
        }

        return jsonResponse({ error: "API route not found." }, { status: 404 });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const status = /not found/i.test(message) ? 404 : /invalid|limit/i.test(message) ? 400 : 500;
        return jsonResponse({ error: message }, { status });
      }
    }

    return jsonResponse({ error: "Not found." }, { status: 404 });
  };
}

export async function resolveBotUsernameFromToken(
  token: string | undefined,
  request: typeof fetch = fetch,
): Promise<string | null> {
  if (!token) return null;
  try {
    const res = await request(`https://api.telegram.org/bot${token}/getMe`, {
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return typeof data?.result?.username === "string" ? data.result.username : null;
  } catch {
    return null;
  }
}

export function startWebHttpServer(
  db: Database,
  options: WebServerOptions = {},
) {
  const configuredPort = Deno.env.get("EYRI_WEB_PORT") ?? "3000";
  if (!/^\d+$/.test(configuredPort)) {
    throw new Error("EYRI_WEB_PORT must be an integer between 0 and 65535.");
  }
  const port = Number(configuredPort);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error("EYRI_WEB_PORT must be an integer between 0 and 65535.");
  }
  if (port === 0) return null;
  const hostname = Deno.env.get("EYRI_WEB_HOST") ?? "127.0.0.1";
  return Deno.serve(
    {
      hostname,
      port,
      onListen: () =>
        console.log(`Eyri Web listening at http://${hostname}:${port}`),
    },
    createWebHttpHandler(db, options),
  );
}
