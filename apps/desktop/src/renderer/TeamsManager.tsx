import { useCallback, useEffect, useState } from "react";
import type { TeamsAction, TeamsActionPayload, TeamsLimit, TeamsMessage, TeamsState, TeamsTeam } from "../shared/desktop-api";
import { deriveChatKey, openMessage, sealMessage } from "./teams-crypto";
import { inviteQrDataUrl } from "./teams-qr";

const APP_MARK = "./glyphi.png";

/**
 * The Teams window: the manager a boss opens to create a group, hand out an
 * invite code, set a daily cap per member, read what each person chose to share,
 * and talk to the team.
 *
 * Everything is a call through `window.glyphi.teamsAction`; the session token
 * lives in the main process and never reaches this renderer. Chat plaintext only
 * exists here — the API stores ciphertext.
 */
export function TeamsManager(): React.JSX.Element {
  const [state, setState] = useState<TeamsState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<"sign-in" | "sign-up">("sign-in");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [teamName, setTeamName] = useState("");
  const [code, setCode] = useState("");

  const load = useCallback(async () => {
    const next = await window.glyphi.getTeamsState();
    setState(next);
    setError(next.error);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const run = useCallback(
    async (action: TeamsAction, payload?: TeamsActionPayload) => {
      setBusy(true);
      setError(null);
      try {
        const next = await window.glyphi.teamsAction(action, payload);
        setState(next);
        setError(next.error);
        return next;
      } finally {
        setBusy(false);
      }
    },
    []
  );

  const money = (micros: number): string => `$${(micros / 1_000_000).toFixed(2)}`;
  const compact = (value: number): string =>
    new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(value);

  const field: React.CSSProperties = {
    width: "100%",
    padding: "9px 12px",
    borderRadius: 10,
    border: "1px solid rgba(255,255,255,0.14)",
    background: "rgba(255,255,255,0.05)",
    color: "inherit",
    font: "inherit",
    fontSize: 13
  };
  const button: React.CSSProperties = {
    padding: "9px 16px",
    borderRadius: 10,
    border: "1px solid rgba(185,139,69,0.55)",
    background: "rgba(185,139,69,0.18)",
    color: "inherit",
    font: "inherit",
    fontSize: 13,
    fontWeight: 600,
    cursor: busy ? "progress" : "pointer"
  };
  const ghost: React.CSSProperties = { ...button, border: "1px solid rgba(255,255,255,0.16)", background: "transparent", fontWeight: 500 };
  const card: React.CSSProperties = {
    padding: 18,
    borderRadius: 16,
    border: "1px solid rgba(255,255,255,0.1)",
    background: "rgba(255,255,255,0.04)"
  };

  if (!state) {
    return (
      <div style={{ padding: 32, fontSize: 13, opacity: 0.7 }}>Opening Teams…</div>
    );
  }

  if (!state.signedIn) {
    return (
      <div style={{ maxWidth: 460, margin: "0 auto", padding: "40px 24px" }}>
        <p style={{ fontSize: 11, letterSpacing: "0.14em", textTransform: "uppercase", opacity: 0.6, margin: 0 }}>
          Glyphi Teams
        </p>
        <h1 style={{ fontSize: 30, fontWeight: 500, margin: "6px 0 8px" }}>Manage your team.</h1>
        <p style={{ fontSize: 13, opacity: 0.7, marginBottom: 18 }}>
          One account per person. The boss creates the group and shares a code; everyone else joins with it.
        </p>

        <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
          <button style={mode === "sign-in" ? button : ghost} onClick={() => setMode("sign-in")} type="button">
            Sign in
          </button>
          <button style={mode === "sign-up" ? button : ghost} onClick={() => setMode("sign-up")} type="button">
            Create an account
          </button>
        </div>

        <form
          style={{ display: "grid", gap: 10 }}
          onSubmit={(event) => {
            event.preventDefault();
            void run(mode, { email, password, displayName });
          }}
        >
          {mode === "sign-up" ? (
            <input
              style={field}
              placeholder="Your name"
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
              autoComplete="name"
            />
          ) : null}
          <input
            style={field}
            placeholder="Email"
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            autoComplete="email"
            required
          />
          <input
            style={field}
            placeholder="Password (8 characters or more)"
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            autoComplete={mode === "sign-in" ? "current-password" : "new-password"}
            required
          />
          <button style={button} type="submit" disabled={busy}>
            {busy ? "Working…" : mode === "sign-in" ? "Sign in" : "Create the account"}
          </button>
        </form>

        {error ? <p style={{ marginTop: 14, fontSize: 13, color: "#e0a08f" }}>{error}</p> : null}
      </div>
    );
  }

  return (
    <div style={{ padding: "28px 32px 40px", display: "grid", gap: 18 }}>
      <header style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 16, flexWrap: "wrap" }}>
        <div>
          <p style={{ fontSize: 11, letterSpacing: "0.14em", textTransform: "uppercase", opacity: 0.6, margin: 0 }}>
            Glyphi Teams
          </p>
          <h1 style={{ fontSize: 28, fontWeight: 500, margin: "4px 0 2px" }}>{state.account?.displayName}</h1>
          <p style={{ fontSize: 12, opacity: 0.6, margin: 0 }}>{state.account?.email}</p>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button
            style={button}
            type="button"
            onClick={() => void run("sync")}
            disabled={busy || state.teams.length === 0}
            title="Send the last thirty days of local usage to every team you are in"
          >
            {busy ? "Sharing…" : "Share my last 30 days"}
          </button>
          <button style={ghost} type="button" onClick={() => void run("sign-out")} disabled={busy}>
            Sign out
          </button>
        </div>
      </header>

      {error ? <p style={{ margin: 0, fontSize: 13, color: "#e0a08f" }}>{error}</p> : null}

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        <form
          style={{ ...card, display: "grid", gap: 10 }}
          onSubmit={(event) => {
            event.preventDefault();
            void run("create", { name: teamName }).then((next) => {
              if (!next.error) setTeamName("");
            });
          }}
        >
          <strong style={{ fontSize: 14 }}>Create a team</strong>
          <p style={{ margin: 0, fontSize: 12, opacity: 0.65 }}>You own it, you get the invite code and the caps.</p>
          <input
            style={field}
            placeholder="Team name (Engineering, Studio…)"
            value={teamName}
            onChange={(event) => setTeamName(event.target.value)}
            maxLength={60}
          />
          <button style={button} type="submit" disabled={busy || teamName.trim().length === 0}>
            Create
          </button>
        </form>

        <form
          style={{ ...card, display: "grid", gap: 10 }}
          onSubmit={(event) => {
            event.preventDefault();
            void run("join", { code }).then((next) => {
              if (!next.error) setCode("");
            });
          }}
        >
          <strong style={{ fontSize: 14 }}>Join with a code</strong>
          <p style={{ margin: 0, fontSize: 12, opacity: 0.65 }}>Eight characters, like K4F2-9QX1 — or scan the QR.</p>
          <input
            style={field}
            placeholder="Invite code"
            value={code}
            onChange={(event) => setCode(event.target.value.toUpperCase())}
            maxLength={9}
          />
          <button style={button} type="submit" disabled={busy || code.trim().length < 9}>
            Join
          </button>
        </form>
      </div>

      {state.teams.length === 0 ? (
        <p style={{ fontSize: 13, opacity: 0.7, margin: 0 }}>
          You are not in a team yet. Create one above, or paste the code your boss gave you.
        </p>
      ) : null}

      {state.teams.map((team) => (
        <section key={team.id} style={{ ...card, display: "grid", gap: 16 }}>
          <header style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
            <div>
              <strong style={{ fontSize: 16 }}>{team.name}</strong>
              <p style={{ margin: "2px 0 0", fontSize: 12, opacity: 0.6 }}>
                {team.memberCount} member{team.memberCount === 1 ? "" : "s"} · {team.sharedCount} sharing ·{" "}
                {compact(team.tokens)} tokens all time · {compact(team.tokens7d)} in 7 days · {money(team.costMicros)}
              </p>
            </div>
            <span style={{ fontSize: 12, opacity: 0.55 }}>
              {team.role === "owner" ? "You manage this team" : "Owned by someone else"}
            </span>
          </header>

          {team.inviteCode ? <InviteCard team={team} compactFn={compact} /> : null}

          <CapsTable team={team} limits={state.limits[team.id] ?? []} busy={busy} onSet={(memberId, dailyTokens) => void run("set-limit", { teamId: team.id, memberId, dailyTokens })} compactFn={compact} />

          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13, fontVariantNumeric: "tabular-nums" }}>
              <thead>
                <tr style={{ textAlign: "left", fontSize: 10, letterSpacing: "0.1em", textTransform: "uppercase", opacity: 0.55 }}>
                  <th style={{ padding: "0 12px 8px 0" }}>Member</th>
                  <th style={{ padding: "0 12px 8px 0" }}>Role</th>
                  <th style={{ padding: "0 12px 8px 0" }}>Tokens</th>
                  <th style={{ padding: "0 12px 8px 0" }}>7 days</th>
                  <th style={{ padding: "0 12px 8px 0" }}>Cost</th>
                  <th style={{ padding: "0 12px 8px 0" }}>Active</th>
                  <th style={{ padding: "0 12px 8px 0" }}>Share</th>
                  <th style={{ padding: "0 0 8px 0" }} />
                </tr>
              </thead>
              <tbody>
                {team.members.map((member) => (
                  <tr key={member.id} style={{ borderTop: "1px solid rgba(255,255,255,0.08)" }}>
                    <td style={{ padding: "9px 12px 9px 0" }}>
                      <strong style={{ fontWeight: 600 }}>{member.displayName}</strong>
                      <div style={{ fontSize: 11, opacity: 0.55 }}>{member.email}</div>
                    </td>
                    <td style={{ padding: "9px 12px 9px 0", opacity: 0.75 }}>{member.role}</td>
                    <td style={{ padding: "9px 12px 9px 0" }}>{member.sharesUsage ? compact(member.tokens) : "—"}</td>
                    <td style={{ padding: "9px 12px 9px 0" }}>{member.sharesUsage ? compact(member.tokens7d) : "—"}</td>
                    <td style={{ padding: "9px 12px 9px 0" }}>{member.sharesUsage ? money(member.costMicros) : "—"}</td>
                    <td style={{ padding: "9px 12px 9px 0", opacity: 0.75 }}>
                      {member.sharesUsage ? `${member.activeDays} d` : "not sharing"}
                    </td>
                    <td style={{ padding: "9px 12px 9px 0" }}>
                      <button
                        style={{ ...ghost, padding: "4px 10px", fontSize: 11 }}
                        type="button"
                        onClick={() => void run("share", { teamId: team.id, shares: !member.sharesUsage })}
                        title={
                          member.role === "owner"
                            ? "The owner always shares"
                            : member.sharesUsage
                              ? "Stop sharing my numbers with this team"
                              : "Share my numbers with this team"
                        }
                      >
                        {member.sharesUsage ? "On" : "Off"}
                      </button>
                    </td>
                    <td style={{ padding: "9px 0" }}>
                      {team.role === "owner" && member.role !== "owner" ? (
                        <button
                          style={{ ...ghost, padding: "4px 10px", fontSize: 11 }}
                          type="button"
                          onClick={() => void run("remove", { teamId: team.id, memberId: member.id })}
                        >
                          Remove
                        </button>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <TeamChat team={team} messages={state.messages[team.id] ?? []} busy={busy} onSend={(cipher, iv) => void run("send-message", { teamId: team.id, cipher, iv })} />

          <p style={{ margin: 0, fontSize: 11, opacity: 0.55 }}>
            Members share their numbers from glyphi.xyz/teams: daily tokens, cost and the tool split. Nothing
            else leaves their computer, and the chat never leaves this window unsealed.
          </p>
        </section>
      ))}
    </div>
  );
}

/** The invite code, its QR and a one-click copy. */
function InviteCard({ team, compactFn }: { team: TeamsTeam; compactFn(value: number): string }): React.JSX.Element {
  const [qr, setQr] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let active = true;
    setQr(null);
    if (!team.inviteCode) return;
    void inviteQrDataUrl(team.inviteCode, APP_MARK).then(
      (url) => {
        if (active) setQr(url);
      },
      () => undefined
    );
    return () => {
      active = false;
    };
  }, [team.inviteCode]);

  return (
    <div style={{ display: "flex", gap: 16, alignItems: "center", flexWrap: "wrap" }}>
      {qr ? (
        <img
          alt={`Invite QR code for ${team.name}`}
          src={qr}
          width={132}
          height={132}
          style={{ borderRadius: 14, background: "#f4ece0", padding: 4 }}
        />
      ) : (
        <div
          style={{
            width: 132,
            height: 132,
            borderRadius: 14,
            border: "1px dashed rgba(255,255,255,0.16)",
            display: "grid",
            placeItems: "center",
            fontSize: 11,
            opacity: 0.5,
            textAlign: "center",
            padding: 10
          }}
        >
          Drawing the QR…
        </div>
      )}
      <div style={{ display: "grid", gap: 8 }}>
        <span style={{ fontSize: 10, letterSpacing: "0.12em", textTransform: "uppercase", opacity: 0.55 }}>
          Invite code
        </span>
        <strong style={{ fontSize: 22, letterSpacing: "0.12em" }}>{team.inviteCode}</strong>
        <button
          type="button"
          style={{
            padding: "7px 12px",
            borderRadius: 9,
            border: "1px solid rgba(255,255,255,0.16)",
            background: "transparent",
            color: "inherit",
            font: "inherit",
            fontSize: 12,
            cursor: "pointer",
            justifySelf: "start"
          }}
          onClick={() => {
            void navigator.clipboard?.writeText(team.inviteCode ?? "").then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1600);
            });
          }}
        >
          {copied ? "Copied" : "Copy the code"}
        </button>
        <span style={{ fontSize: 11, opacity: 0.5 }}>
          Scanning joins the team and unlocks the chat on that machine.
        </span>
        <span style={{ fontSize: 11, opacity: 0.4 }}>
          {team.memberCount} member{team.memberCount === 1 ? "" : "s"} · {compactFn(team.tokens)} tokens shared
        </span>
      </div>
    </div>
  );
}

/** The daily cap per member, editable by the owner. */
function CapsTable({
  team,
  limits,
  busy,
  onSet,
  compactFn
}: {
  team: TeamsTeam;
  limits: TeamsLimit[];
  busy: boolean;
  onSet(memberId: string, dailyTokens: number): void;
  compactFn(value: number): string;
}): React.JSX.Element | null {
  const [drafts, setDrafts] = useState<Record<string, string>>({});

  if (limits.length === 0) return null;

  return (
    <div style={{ display: "grid", gap: 8 }}>
      <span style={{ fontSize: 10, letterSpacing: "0.12em", textTransform: "uppercase", opacity: 0.55 }}>
        Daily token cap
      </span>
      <div style={{ display: "grid", gap: 6 }}>
        {limits.map((limit) => {
          const draft = drafts[limit.memberId] ?? (limit.dailyTokens > 0 ? String(limit.dailyTokens) : "");
          const field = {
            width: 120,
            padding: "6px 9px",
            borderRadius: 8,
            border: "1px solid rgba(255,255,255,0.14)",
            background: "rgba(255,255,255,0.05)",
            color: "inherit",
            font: "inherit",
            fontSize: 12
          } as React.CSSProperties;
          return (
            <div
              key={limit.memberId}
              style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", fontSize: 12 }}
            >
              <strong style={{ minWidth: 120, fontWeight: 600 }}>{limit.displayName}</strong>
              <span style={{ opacity: 0.6 }}>
                {compactFn(limit.todayTokens)} tokens today
                {limit.dailyTokens > 0 ? ` / ${compactFn(limit.dailyTokens)}` : ""}
              </span>
              {limit.over ? (
                <span
                  style={{
                    padding: "2px 8px",
                    borderRadius: 999,
                    border: "1px solid rgba(224,160,143,0.5)",
                    color: "#e0a08f",
                    fontSize: 10,
                    letterSpacing: "0.08em",
                    textTransform: "uppercase"
                  }}
                >
                  Over cap
                </span>
              ) : null}
              {team.role === "owner" ? (
                <>
                  <input
                    aria-label={`Daily cap for ${limit.displayName}`}
                    inputMode="numeric"
                    placeholder="No cap"
                    style={field}
                    value={draft}
                    onChange={(event) =>
                      setDrafts((current) => ({ ...current, [limit.memberId]: event.target.value.replace(/[^0-9]/gu, "") }))
                    }
                  />
                  <button
                    type="button"
                    disabled={busy}
                    style={{
                      padding: "6px 12px",
                      borderRadius: 8,
                      border: "1px solid rgba(185,139,69,0.55)",
                      background: "rgba(185,139,69,0.16)",
                      color: "inherit",
                      font: "inherit",
                      fontSize: 12,
                      cursor: busy ? "progress" : "pointer"
                    }}
                    onClick={() => onSet(limit.memberId, Number(draft || "0"))}
                  >
                    Save cap
                  </button>
                </>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** The sealed team conversation. */
function TeamChat({
  team,
  messages,
  busy,
  onSend
}: {
  team: TeamsTeam;
  messages: TeamsMessage[];
  busy: boolean;
  onSend(cipher: string, iv: string): void;
}): React.JSX.Element {
  const [key, setKey] = useState<CryptoKey | null>(null);
  const [plain, setPlain] = useState<Record<string, string>>({});
  const [draft, setDraft] = useState("");

  useEffect(() => {
    let active = true;
    setKey(null);
    setPlain({});
    if (!team.secret) return;
    void deriveChatKey(team.secret, team.id).then(
      (derived) => {
        if (active) setKey(derived);
      },
      () => undefined
    );
    return () => {
      active = false;
    };
  }, [team.secret, team.id]);

  useEffect(() => {
    let active = true;
    if (!key) return;
    void (async () => {
      const next: Record<string, string> = {};
      for (const message of messages) {
        next[message.id] = await openMessage(key, message.cipher, message.iv).catch(() => "—");
      }
      if (active) setPlain(next);
    })();
    return () => {
      active = false;
    };
  }, [key, messages]);

  const send = async (): Promise<void> => {
    const text = draft.trim();
    if (!text || !key) return;
    const sealed = await sealMessage(key, text);
    setDraft("");
    onSend(sealed.cipher, sealed.iv);
  };

  return (
    <div style={{ display: "grid", gap: 8 }}>
      <span style={{ fontSize: 10, letterSpacing: "0.12em", textTransform: "uppercase", opacity: 0.55 }}>
        Team chat · sealed with AES-256-GCM
      </span>

      {!team.secret ? (
        <p style={{ margin: 0, fontSize: 12, opacity: 0.6 }}>
          This machine does not know the invite code, so it cannot read the chat. Paste the code in “Join with a code”
          once to unlock it.
        </p>
      ) : (
        <>
          <div
            style={{
              display: "grid",
              gap: 6,
              maxHeight: 220,
              overflowY: "auto",
              padding: "10px 12px",
              borderRadius: 12,
              border: "1px solid rgba(255,255,255,0.08)",
              background: "rgba(0,0,0,0.12)"
            }}
          >
            {messages.length === 0 ? (
              <p style={{ margin: 0, fontSize: 12, opacity: 0.5 }}>No messages yet. Say hello.</p>
            ) : (
              messages.map((message) => (
                <div key={message.id} style={{ fontSize: 12, display: "grid", gap: 2 }}>
                  <span style={{ opacity: 0.5, fontSize: 10 }}>
                    {message.mine ? "You" : message.displayName} ·{" "}
                    {new Date(message.createdAt).toLocaleString(undefined, {
                      month: "short",
                      day: "numeric",
                      hour: "2-digit",
                      minute: "2-digit"
                    })}
                  </span>
                  <span style={{ opacity: 0.9 }}>{plain[message.id] ?? "…"}</span>
                </div>
              ))
            )}
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <input
              style={{
                flex: 1,
                padding: "9px 12px",
                borderRadius: 10,
                border: "1px solid rgba(255,255,255,0.14)",
                background: "rgba(255,255,255,0.05)",
                color: "inherit",
                font: "inherit",
                fontSize: 13
              }}
              placeholder="Message the team…"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  void send();
                }
              }}
              maxLength={2000}
            />
            <button
              type="button"
              disabled={busy || draft.trim().length === 0}
              onClick={() => void send()}
              style={{
                padding: "9px 16px",
                borderRadius: 10,
                border: "1px solid rgba(185,139,69,0.55)",
                background: "rgba(185,139,69,0.18)",
                color: "inherit",
                font: "inherit",
                fontSize: 13,
                fontWeight: 600,
                cursor: busy ? "progress" : "pointer"
              }}
            >
              Send
            </button>
          </div>
        </>
      )}
    </div>
  );
}
