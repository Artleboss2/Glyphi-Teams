import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

/**
 * Freebuff Cloud as a second source.
 *
 * The desktop app used to mirror every turn into a local SQLite database. When
 * that mirror stops being written — the app moved most of the work server-side —
 * the local reader has nothing to show, and the tracked total silently stays at
 * zero. The service itself still answers, with the session quota and the credit
 * balance, on the same origin the CLI uses:
 *
 *   GET  /api/v1/freebuff/session   daily and weekly session quota
 *   POST /api/v1/usage              credit usage and remaining balance
 *
 * Both take a plain bearer token. There is no per-day token history behind this
 * API: it reports sessions and credits, not the prompt-level token counts the
 * local database carries. So this is a *fallback* — it tells the dashboard the
 * tool is alive and what is left today, and it never invents token numbers.
 */

const CLOUD_ORIGIN = "https://www.codebuff.com";
const TIMEOUT_MS = 8_000;

export interface FreebuffCloudQuota {
  /** Sessions spent today and the daily cap, when the service reports them. */
  dayUsed: number | null;
  dayLimit: number | null;
  /** Credits left on the account, when the service reports them. */
  creditsRemaining: number | null;
}

interface CloudOptions {
  environment?: NodeJS.ProcessEnv;
  homeDirectory?: string;
  fetchImpl?: typeof fetch;
}

/**
 * The token the CLI stores after `codebuff login`, or one the machine owner put
 * in the environment. Nothing else is guessed: a missing token means the cloud
 * source is simply unavailable, never an error the window has to show.
 */
export async function resolveFreebuffToken(options: CloudOptions = {}): Promise<string | null> {
  const environment = options.environment ?? process.env;
  const fromEnvironment = environment.FREEBUFF_API_KEY?.trim() || environment.CODEBUFF_API_KEY?.trim();
  if (fromEnvironment) return fromEnvironment;

  const home = options.homeDirectory ?? homedir();
  const appData = environment.APPDATA?.trim();

  // A plain one-line file is the simplest place to keep the token: no keychain,
  // no settings screen, and the account owner can drop it in with Notepad.
  for (const file of [
    ...(appData ? [path.join(appData, "Glyphi", "freebuff-api-key")] : []),
    path.join(home, ".config", "glyphi", "freebuff-api-key")
  ]) {
    try {
      const token = (await readFile(file, "utf8")).split(/\r?\n/u)[0]?.trim();
      if (token && token.length >= 20) return token;
    } catch {
      // No file here either.
    }
  }

  for (const candidate of [
    path.join(home, ".config", "manicode", "credentials.json"),
    path.join(home, ".config", "manicode-dev", "credentials.json"),
    path.join(home, ".config", "freebuff", "credentials.json"),
    path.join(home, ".codebuff", "credentials.json")
  ]) {
    try {
      const raw = JSON.parse(await readFile(candidate, "utf8")) as Record<string, unknown>;
      const auth = raw.default as Record<string, unknown> | undefined;
      const token = auth?.authToken ?? raw.authToken;
      if (typeof token === "string" && token.length >= 20) return token;
    } catch {
      // No file, no token: the next candidate decides.
    }
  }
  return null;
}

function number(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

/** One GET on the session endpoint; the quota lives under `usage` or `daily`. */
export async function readFreebuffCloudQuota(options: CloudOptions = {}): Promise<FreebuffCloudQuota | null> {
  // Nothing is polled and nothing is stored: one request when the dashboard
  // refreshes, and the answer is thrown away with the render.
  const token = await resolveFreebuffToken(options);
  if (!token) return null;
  const doFetch = options.fetchImpl ?? fetch;

  try {
    const response = await doFetch(`${CLOUD_ORIGIN}/api/v1/freebuff/session`, {
      headers: {
        authorization: `Bearer ${token}`,
        "include-unused-rate-limits": "1"
      },
      signal: AbortSignal.timeout(TIMEOUT_MS)
    });
    if (!response.ok) return null;
    const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body) return null;

    const usage = (body.usage ?? {}) as Record<string, unknown>;
    const daily = (body.daily ?? {}) as Record<string, unknown>;
    const dayUsed = number(usage.dayUsed) ?? number(daily.spent) ?? number(daily.used);
    const dayLimit = number(usage.dayLimit) ?? number(daily.limit);
    const creditsRemaining = number(body.balance) ?? number(body.wallet_balance);
    if (dayUsed === null && dayLimit === null && creditsRemaining === null) return null;
    return { dayUsed, dayLimit, creditsRemaining };
  } catch {
    // Offline, refused, or a token that went stale: the local reader stays the
    // only source and the dashboard is no worse for it.
    return null;
  }
}
