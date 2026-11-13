/**
 * Glyphi Teams API.
 *
 * One Edge Function for the team edition: accounts, sessions, teams, invite
 * codes, membership and the daily aggregates members share. It is the only
 * holder of the service-role key, and every database call goes through a
 * `teams_api_*` security-definer function that validates its input again.
 *
 * The same rule as the single-player API: the account always comes from the
 * hashed session token, never from something the browser sends.
 */

const SUPABASE_URL = requireEnv("SUPABASE_URL");
const SERVICE_KEY = requireEnv("SUPABASE_SERVICE_ROLE_KEY");
const SESSION_TTL_SECONDS = 90 * 24 * 60 * 60;
const MAX_BYTES = 512 * 1024;

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "authorization, content-type",
  "access-control-max-age": "86400"
} as const;

function requireEnv(name: string): string {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`${name} is not configured`);
  return value;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      ...CORS
    }
  });
}

function randomHex(bytes: number): string {
  const buffer = new Uint8Array(bytes);
  crypto.getRandomValues(buffer);
  return [...buffer].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function readJson(request: Request): Promise<Record<string, unknown> | null> {
  const length = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(length) && length > MAX_BYTES) return null;
  const text = await request.text();
  if (text.length > MAX_BYTES) return null;
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

class ApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

/** Calls one hardened database function. PostgREST sees only these. */
async function rpc<T>(name: string, args: Record<string, unknown>): Promise<T> {
  const response = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${name}`, {
    method: "POST",
    headers: {
      apikey: SERVICE_KEY,
      authorization: `Bearer ${SERVICE_KEY}`,
      "content-type": "application/json"
    },
    body: JSON.stringify(args),
    signal: AbortSignal.timeout(20_000)
  });
  const text = await response.text();
  if (!response.ok) {
    let message = "";
    try {
      message = String(JSON.parse(text)?.message ?? "");
    } catch {
      message = text.slice(0, 200);
    }
    throw new ApiError(400, message || "database_error");
  }
  return (text ? JSON.parse(text) : null) as T;
}

function clientIp(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for") ?? "";
  const first = forwarded.split(",")[0]?.trim();
  return first && /^[0-9a-fA-F:.]{3,45}$/u.test(first) ? first : "unknown";
}

async function limit(request: Request, name: string, max: number, seconds: number, who = clientIp(request)): Promise<void> {
  const allowed = await rpc<boolean>("teams_api_rate_hit", {
    p_bucket: `${name}:${who}`.slice(0, 200),
    p_limit: max,
    p_window_seconds: seconds
  });
  if (!allowed) throw new ApiError(429, "rate_limited");
}

interface Session {
  accountId: string;
  email: string;
  displayName: string;
}

async function authorize(request: Request): Promise<Session> {
  const header = request.headers.get("authorization") ?? "";
  if (!header.startsWith("Bearer ")) throw new ApiError(401, "unauthorized");
  const token = header.slice(7).trim();
  if (token.length < 20 || token.length > 200) throw new ApiError(401, "unauthorized");
  const session = await rpc<Session | null>("teams_api_session_auth", {
    p_token_hash: await sha256Hex(token)
  });
  if (!session) throw new ApiError(401, "unauthorized");
  return session;
}

async function openSession(accountId: string): Promise<{ access_token: string; expires_in: number }> {
  const token = `${randomHex(32)}${randomHex(16)}`;
  const expires = new Date(Date.now() + SESSION_TTL_SECONDS * 1000).toISOString();
  await rpc<void>("teams_api_session_create", {
    p_token_hash: await sha256Hex(token),
    p_account: accountId,
    p_expires_at: expires
  });
  return { access_token: token, expires_in: SESSION_TTL_SECONDS };
}

async function signUp(request: Request): Promise<Response> {
  await limit(request, "sign-up", 20, 3600);
  const body = await readJson(request);
  if (!body) return json(400, { error: "invalid_request" });

  const result = await rpc<{ ok?: boolean; error?: string; accountId?: string; email?: string }>(
    "teams_api_account_register",
    {
      p_email: typeof body.email === "string" ? body.email : "",
      p_password: typeof body.password === "string" ? body.password : "",
      p_display_name: typeof body.displayName === "string" ? body.displayName : null
    }
  );
  if (!result?.ok || !result.accountId) {
    return json(400, { error: result?.error ?? "sign_up_failed" });
  }

  const session = await openSession(result.accountId);
  return json(201, { ...session, token_type: "bearer" });
}

async function signIn(request: Request): Promise<Response> {
  await limit(request, "sign-in", 40, 3600);
  const body = await readJson(request);
  if (!body) return json(400, { error: "invalid_request" });

  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  const password = typeof body.password === "string" ? body.password : "";
  if (!email || !password) return json(400, { error: "invalid_request" });
  await limit(request, "sign-in-email", 15, 3600, email.slice(0, 120));

  const result = await rpc<{ ok?: boolean; error?: string; accountId?: string }>("teams_api_account_login", {
    p_email: email,
    p_password: password
  });
  if (!result?.ok || !result.accountId) return json(401, { error: "invalid_credentials" });

  const session = await openSession(result.accountId);
  return json(200, { ...session, token_type: "bearer" });
}

async function getSession(request: Request): Promise<Response> {
  const session = await authorize(request);
  return json(200, {
    user: { id: session.accountId, email: session.email, displayName: session.displayName }
  });
}

async function signOut(request: Request): Promise<Response> {
  const header = request.headers.get("authorization") ?? "";
  if (header.startsWith("Bearer ")) {
    await rpc<void>("teams_api_session_delete", { p_token_hash: await sha256Hex(header.slice(7).trim()) });
  }
  return json(200, {});
}

function pathOf(url: URL): string {
  const prefixed = "/functions/v1/glyphi-teams-api";
  let path = url.pathname;
  if (path.startsWith(prefixed)) path = path.slice(prefixed.length);
  else if (path.startsWith("/glyphi-teams-api")) path = path.slice("/glyphi-teams-api".length);
  return path === "" ? "/" : path.replace(/\/+$/u, "") || "/";
}

Deno.serve(async (request) => {
  const url = new URL(request.url);
  const path = pathOf(url);
  const method = request.method;

  try {
    if (method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    if (path === "/healthz" && method === "GET") return json(200, { ok: true });

    if (path === "/api/auth/sign-up" && method === "POST") return await signUp(request);
    if (path === "/api/auth/sign-in" && method === "POST") return await signIn(request);
    if (path === "/api/auth/get-session" && method === "GET") return await getSession(request);
    if (path === "/api/auth/sign-out" && method === "POST") return await signOut(request);

    if (path === "/api/teams" && method === "GET") {
      const session = await authorize(request);
      await limit(request, "overview", 240, 3600, session.accountId);
      return json(200, { teams: (await rpc<unknown[]>("teams_api_overview", { p_account: session.accountId })) ?? [] });
    }

    if (path === "/api/teams" && method === "POST") {
      const session = await authorize(request);
      await limit(request, "team-create", 20, 3600, session.accountId);
      const body = await readJson(request);
      const name = typeof body?.name === "string" ? body.name : "";
      const result = await rpc<{ ok?: boolean; error?: string }>("teams_api_team_create", {
        p_account: session.accountId,
        p_name: name
      });
      return result?.ok ? json(201, result) : json(400, { error: result?.error ?? "team_create_failed" });
    }

    if (path === "/api/teams/join" && method === "POST") {
      const session = await authorize(request);
      await limit(request, "team-join", 30, 3600, session.accountId);
      const body = await readJson(request);
      const code = typeof body?.code === "string" ? body.code : "";
      const result = await rpc<{ ok?: boolean; error?: string }>("teams_api_team_join", {
        p_account: session.accountId,
        p_code: code
      });
      return result?.ok ? json(200, result) : json(400, { error: result?.error ?? "join_failed" });
    }

    if (path === "/api/teams/usage" && method === "POST") {
      const session = await authorize(request);
      await limit(request, "usage-push", 120, 3600, session.accountId);
      const body = await readJson(request);
      const days = Array.isArray(body?.days) ? body.days : [];
      // Only totals and a per-tool split are accepted; anything else is dropped
      // by the database function before it is written.
      const written = await rpc<number>("teams_api_usage_push", { p_account: session.accountId, p_days: days });
      return json(200, { ok: true, written });
    }

    if (path === "/api/teams/sharing" && method === "POST") {
      const session = await authorize(request);
      const body = await readJson(request);
      const teamId = typeof body?.teamId === "string" ? body.teamId : "";
      if (!/^[0-9a-f-]{36}$/u.test(teamId)) return json(400, { error: "invalid_request" });
      const changed = await rpc<boolean>("teams_api_sharing_set", {
        p_account: session.accountId,
        p_team: teamId,
        p_shares: body?.shares !== false
      });
      return changed ? json(200, { ok: true }) : json(404, { error: "not_a_member" });
    }

    if (path === "/api/teams/members/remove" && method === "POST") {
      const session = await authorize(request);
      const body = await readJson(request);
      const teamId = typeof body?.teamId === "string" ? body.teamId : "";
      const memberId = typeof body?.memberId === "string" ? body.memberId : "";
      if (!/^[0-9a-f-]{36}$/u.test(teamId) || !/^[0-9a-f-]{36}$/u.test(memberId)) {
        return json(400, { error: "invalid_request" });
      }
      const removed = await rpc<boolean>("teams_api_member_remove", {
        p_actor: session.accountId,
        p_team: teamId,
        p_member: memberId
      });
      return removed ? json(200, { ok: true }) : json(403, { error: "not_allowed" });
    }

    if (path === "/api/teams/limits" && method === "GET") {
      const session = await authorize(request);
      const teamId = url.searchParams.get("teamId") ?? "";
      if (!/^[0-9a-f-]{36}$/u.test(teamId)) return json(400, { error: "invalid_request" });
      await limit(request, "limits", 480, 3600, session.accountId);
      const rows = await rpc<unknown[]>("teams_api_limits", { p_account: session.accountId, p_team: teamId });
      return json(200, { limits: rows ?? [] });
    }

    if (path === "/api/teams/limits" && method === "POST") {
      const session = await authorize(request);
      await limit(request, "limit-set", 240, 3600, session.accountId);
      const body = await readJson(request);
      const teamId = typeof body?.teamId === "string" ? body.teamId : "";
      const memberId = typeof body?.memberId === "string" ? body.memberId : "";
      if (!/^[0-9a-f-]{36}$/u.test(teamId) || !/^[0-9a-f-]{36}$/u.test(memberId)) {
        return json(400, { error: "invalid_request" });
      }
      const raw = typeof body?.dailyTokens === "number" ? body.dailyTokens : 0;
      if (!Number.isFinite(raw) || raw < 0) return json(400, { error: "invalid_request" });
      const result = await rpc<{ ok?: boolean; error?: string; dailyTokens?: number }>("teams_api_limit_set", {
        p_actor: session.accountId,
        p_team: teamId,
        p_member: memberId,
        p_daily_tokens: Math.min(Math.round(raw), 1_000_000_000_000)
      });
      return result?.ok ? json(200, result) : json(403, { error: result?.error ?? "limit_failed" });
    }

    if (path === "/api/teams/messages" && method === "GET") {
      const session = await authorize(request);
      const teamId = url.searchParams.get("teamId") ?? "";
      if (!/^[0-9a-f-]{36}$/u.test(teamId)) return json(400, { error: "invalid_request" });
      const before = url.searchParams.get("before");
      const stamp = before && /^\d{4}-\d{2}-\d{2}T[0-9:.]+Z?$/u.test(before) ? before : null;
      await limit(request, "messages", 900, 3600, session.accountId);
      const rows = await rpc<unknown[]>("teams_api_messages", {
        p_account: session.accountId,
        p_team: teamId,
        p_limit: 100,
        p_before: stamp
      });
      return json(200, { messages: rows ?? [] });
    }

    if (path === "/api/teams/messages" && method === "POST") {
      const session = await authorize(request);
      await limit(request, "message-send", 240, 3600, session.accountId);
      const body = await readJson(request);
      const teamId = typeof body?.teamId === "string" ? body.teamId : "";
      const cipher = typeof body?.cipher === "string" ? body.cipher : "";
      const iv = typeof body?.iv === "string" ? body.iv : "";
      if (!/^[0-9a-f-]{36}$/u.test(teamId)) return json(400, { error: "invalid_request" });
      if (cipher.length < 1 || cipher.length > 8192 || iv.length < 8 || iv.length > 64) {
        return json(400, { error: "message_invalid" });
      }
      const result = await rpc<{ ok?: boolean; error?: string; id?: string; createdAt?: string }>(
        "teams_api_message_send",
        { p_account: session.accountId, p_team: teamId, p_cipher: cipher, p_iv: iv }
      );
      return result?.ok ? json(201, result) : json(403, { error: result?.error ?? "message_failed" });
    }

    return json(404, { error: "not_found" });
  } catch (error) {
    if (error instanceof ApiError) {
      return json(error.status, { error: error.status === 429 ? "rate_limited" : "request_failed" });
    }
    console.error("glyphi-teams-api failed", error instanceof Error ? error.name : "unknown");
    return json(500, { error: "server_error" });
  }
});
