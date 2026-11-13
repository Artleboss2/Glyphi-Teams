import { app } from "electron";
import fs from "node:fs";
import path from "node:path";
import { readUsageDays } from "./teams-usage";
import type {
  TeamsAction,
  TeamsActionPayload,
  TeamsLimit,
  TeamsMember,
  TeamsMessage,
  TeamsState,
  TeamsTeam,
  TeamsUsageDay
} from "../shared/desktop-api";

/**
 * The Teams window's only way out: a small client for the Glyphi Teams API.
 *
 * The session token never leaves the main process. It is written to a 0600 file
 * under the app's user data so the window survives a restart, and the account
 * is re-read from the API on every refresh rather than trusted from that file.
 *
 * The same file keeps the invite code of every team this machine created or
 * joined. That code is the team secret: the chat key is derived from it in the
 * renderer, and the server never receives either the code or the key.
 */

const TEAMS_API = (
  process.env.GLYPHI_TEAMS_API ??
  "https://tjdafexistcjcaworupt.supabase.co/functions/v1/glyphi-teams-api"
).replace(/\/+$/u, "");

interface StoredSession {
  token: string;
  email: string;
  displayName: string;
  /** team id → invite code, kept so this machine can read the team chat. */
  codes?: Record<string, string>;
}

interface ApiTeam {
  id: string;
  name: string;
  role: "owner" | "member";
  inviteCode: string | null;
  createdAt: string;
  memberCount: number;
  sharedCount: number;
  tokens: number;
  tokens7d: number;
  costMicros: number;
  members: TeamsMember[];
}

function emptyState(error: string | null = null): TeamsState {
  return { signedIn: false, account: null, teams: [], limits: {}, messages: {}, error };
}

export class TeamsClient {
  private session: StoredSession | null = null;
  private loaded = false;

  /** Where the app keeps its local history, so `sync` can read today's totals. */
  constructor(private readonly historyPath: () => string = () => "") {}

  private file(): string {
    return path.join(app.getPath("userData"), "teams-session.json");
  }

  private load(): void {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const raw = JSON.parse(fs.readFileSync(this.file(), "utf8")) as StoredSession;
      if (raw && typeof raw.token === "string" && raw.token.length >= 20) this.session = raw;
    } catch {
      this.session = null;
    }
  }

  private persist(): void {
    try {
      if (!this.session) {
        fs.rmSync(this.file(), { force: true });
        return;
      }
      fs.writeFileSync(this.file(), JSON.stringify(this.session), { mode: 0o600 });
    } catch {
      // A read-only user data folder must not break the window.
    }
  }

  /** The invite code this machine knows for a team, when it has one. */
  private secretFor(team: ApiTeam): string | null {
    return this.session?.codes?.[team.id] ?? team.inviteCode ?? null;
  }

  private remember(teamId: string, code: string | null | undefined): void {
    if (!this.session || !teamId || !code) return;
    if (!/^[A-Z0-9]{4}-[A-Z0-9]{4}$/u.test(code)) return;
    this.session.codes = { ...(this.session.codes ?? {}), [teamId]: code };
    this.persist();
  }

  private async call<T>(pathname: string, init: RequestInit = {}): Promise<{ ok: boolean; status: number; body: T | null }> {
    const response = await fetch(`${TEAMS_API}${pathname}`, {
      ...init,
      headers: {
        ...(init.body ? { "content-type": "application/json" } : {}),
        ...(this.session ? { authorization: `Bearer ${this.session.token}` } : {}),
        ...(init.headers ?? {})
      },
      signal: AbortSignal.timeout(20_000)
    });
    const body = (await response.json().catch(() => null)) as T | null;
    return { ok: response.ok, status: response.status, body };
  }

  private async fetchTeams(): Promise<TeamsState> {
    if (!this.session) return emptyState();
    const result = await this.call<{ teams: ApiTeam[] }>("/api/teams");
    if (result.status === 401) {
      this.session = null;
      this.persist();
      return { ...emptyState(), expired: true };
    }
    if (!result.ok || !result.body) return { ...emptyState("Teams could not be reached.") };

    const teams: TeamsTeam[] = (result.body.teams ?? []).map((team) => ({
      id: team.id,
      name: team.name,
      role: team.role,
      inviteCode: team.inviteCode,
      secret: this.secretFor(team),
      createdAt: team.createdAt,
      memberCount: team.memberCount,
      sharedCount: team.sharedCount,
      tokens: team.tokens,
      tokens7d: team.tokens7d,
      costMicros: team.costMicros,
      members: team.members ?? []
    }));

    // The manager window always shows the board, the caps and the conversation,
    // so those two pages are fetched with the overview rather than on a click.
    const limits: Record<string, TeamsLimit[]> = {};
    const messages: Record<string, TeamsMessage[]> = {};
    for (const team of teams) {
      const caps = await this.call<{ limits: TeamsLimit[] }>(`/api/teams/limits?teamId=${team.id}`);
      if (caps.ok && caps.body) limits[team.id] = caps.body.limits ?? [];
      const chat = await this.call<{ messages: TeamsMessage[] }>(`/api/teams/messages?teamId=${team.id}`);
      if (chat.ok && chat.body) messages[team.id] = chat.body.messages ?? [];
    }

    return {
      signedIn: true,
      account: { id: "", email: this.session.email, displayName: this.session.displayName },
      teams,
      limits,
      messages,
      error: null
    };
  }

  async status(): Promise<TeamsState> {
    this.load();
    try {
      return await this.fetchTeams();
    } catch {
      return emptyState("Teams could not be reached.");
    }
  }

  async run(action: TeamsAction, payload: TeamsActionPayload = {}): Promise<TeamsState> {
    this.load();

    try {
      if (action === "sign-in" || action === "sign-up") {
        const email = String(payload.email ?? "").trim();
        const password = String(payload.password ?? "");
        if (!email || !password) return emptyState("Enter an email and a password.");
        const result = await this.call<{ access_token?: string; error?: string }>(
          action === "sign-in" ? "/api/auth/sign-in" : "/api/auth/sign-up",
          {
            method: "POST",
            body: JSON.stringify({ email, password, displayName: payload.displayName ?? null })
          }
        );
        if (!result.ok || !result.body?.access_token) {
          return emptyState(
            action === "sign-in" ? "That email and password do not match." : messageFor(result.body?.error)
          );
        }
        const token = result.body.access_token;
        const probe = await fetch(`${TEAMS_API}/api/auth/get-session`, {
          headers: { authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(15_000)
        });
        const profile = (await probe.json().catch(() => null)) as
          | { user?: { email?: string; displayName?: string } }
          | null;
        this.session = {
          token,
          email: profile?.user?.email ?? email,
          displayName: profile?.user?.displayName ?? email.split("@")[0],
          codes: this.session?.codes
        };
        this.persist();
        return await this.fetchTeams();
      }

      if (action === "sign-out") {
        await this.call("/api/auth/sign-out", { method: "POST", body: "{}" }).catch(() => null);
        this.session = null;
        this.persist();
        return emptyState();
      }

      if (!this.session) return emptyState("Sign in first.");

      if (action === "create") {
        const name = String(payload.name ?? "").trim();
        if (!name) return emptyState("Give the team a name.");
        const result = await this.call<{ error?: string; teamId?: string; inviteCode?: string }>("/api/teams", {
          method: "POST",
          body: JSON.stringify({ name })
        });
        if (!result.ok) return { ...(await this.fetchTeams()), error: messageFor(result.body?.error) };
        if (result.body?.teamId) this.remember(result.body.teamId, result.body.inviteCode);
        return await this.fetchTeams();
      }

      if (action === "join") {
        const code = String(payload.code ?? "").trim().toUpperCase();
        const result = await this.call<{ error?: string; teamId?: string }>("/api/teams/join", {
          method: "POST",
          body: JSON.stringify({ code })
        });
        if (!result.ok) {
          return { ...(await this.fetchTeams()), error: messageFor(result.body?.error) };
        }
        if (result.body?.teamId) this.remember(result.body.teamId, code);
        return await this.fetchTeams();
      }

      if (action === "share") {
        await this.call("/api/teams/sharing", {
          method: "POST",
          body: JSON.stringify({ teamId: payload.teamId, shares: payload.shares !== false })
        });
        return await this.fetchTeams();
      }

      if (action === "remove") {
        const result = await this.call<{ error?: string }>("/api/teams/members/remove", {
          method: "POST",
          body: JSON.stringify({ teamId: payload.teamId, memberId: payload.memberId })
        });
        if (!result.ok) return { ...(await this.fetchTeams()), error: "That member could not be removed." };
        return await this.fetchTeams();
      }

      if (action === "set-limit") {
        const dailyTokens = Number(payload.dailyTokens ?? 0);
        if (!Number.isFinite(dailyTokens) || dailyTokens < 0) {
          return { ...(await this.fetchTeams()), error: "Enter a daily cap in tokens, or zero to remove it." };
        }
        const result = await this.call<{ error?: string }>("/api/teams/limits", {
          method: "POST",
          body: JSON.stringify({ teamId: payload.teamId, memberId: payload.memberId, dailyTokens })
        });
        if (!result.ok) return { ...(await this.fetchTeams()), error: messageFor(result.body?.error) };
        return await this.fetchTeams();
      }

      if (action === "send-message") {
        const cipher = String(payload.cipher ?? "");
        const iv = String(payload.iv ?? "");
        if (!cipher || !iv) return { ...(await this.fetchTeams()), error: "The message could not be sealed." };
        const result = await this.call<{ error?: string }>("/api/teams/messages", {
          method: "POST",
          body: JSON.stringify({ teamId: payload.teamId, cipher, iv })
        });
        if (!result.ok) return { ...(await this.fetchTeams()), error: messageFor(result.body?.error) };
        return await this.fetchTeams();
      }

      if (action === "sync") {
        // The renderer never computes usage: the main process reads the local
        // history database itself and sends only day totals.
        const days: TeamsUsageDay[] = Array.isArray(payload.days)
          ? payload.days.slice(0, 60)
          : readUsageDays(this.historyPath(), 30);
        if (days.length === 0) {
          return { ...(await this.fetchTeams()), error: "There is nothing to share yet." };
        }
        const result = await this.call<{ error?: string }>("/api/teams/usage", {
          method: "POST",
          body: JSON.stringify({ days })
        });
        if (!result.ok) return { ...(await this.fetchTeams()), error: messageFor(result.body?.error) };
        return await this.fetchTeams();
      }

      return await this.fetchTeams();
    } catch {
      return { ...(await this.status()), error: "Teams could not be reached." };
    }
  }
}

function messageFor(code: string | undefined): string {
  switch (code) {
    case "email_taken":
      return "That email already has a Teams account.";
    case "email_format":
      return "Enter a valid email address.";
    case "password_length":
      return "Use a password of at least 8 characters.";
    case "code_format":
    case "code_unknown":
      return "That invite code does not exist.";
    case "name":
      return "Give the team a name.";
    case "not_a_member":
      return "You are not a member of that team.";
    case "not_allowed":
      return "Only the team owner can do that.";
    case "limit_range":
      return "That cap is out of range.";
    case "message_invalid":
      return "That message is too long.";
    case "rate_limited":
      return "Too many attempts. Try again in a few minutes.";
    case "invalid_credentials":
      return "That email and password do not match.";
    default:
      return "Something went wrong.";
  }
}
