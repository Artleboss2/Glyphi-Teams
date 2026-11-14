# Glyphi Teams

The team edition of [Glyphi](https://glyphi.xyz): the same desktop app, plus a **Teams window** where a boss
creates a group, hands out an invite code, and reads what each member chose to share — tokens, cost, active days
and the seven-day trend, per person and for the whole team.

This repository is licensed **MIT** (see `LICENSE`), so it can be used, modified and redistributed in commercial
contexts. The single-player Glyphi app is not: it stays under the PolyForm Noncommercial License.

- Website: <https://glyphi.xyz/teams>
- Issues: <https://github.com/Artleboss2/Glyphi-Teams/issues>

## What the Teams window does

| Role | Can do |
| --- | --- |
| Owner (the boss) | Create the team, read the invite code, see every member's shared totals, remove a member, publish or hide their own profile |
| Member | Join with a code, decide per team whether to share their numbers, remove themselves |

Sharing is per member and per team, and it is **on by default for a new member**: joining a team is already an
answer to "do you want your boss to see this?". Turning it off deletes what was already shared, so the switch
means what it says instead of only stopping future uploads.

## What is shared

Daily totals only: a date, a token count, an estimated cost and the per-tool split. Never prompts, never
completions, never source code, file paths or project names. The Teams database stores one row per member per
day and nothing else.

## Layout

```
apps/desktop        the Electron app, with the Teams window (src/renderer/TeamsManager.tsx)
packages/           the shared contracts and engine packages
supabase/           the Teams backend: schema and the Edge Function that fronts it
```

## Running it

```bash
npm install          # or bun install
npm run desktop:dev  # opens the app; the Teams entry sits in the left rail
```

The Teams window talks to the API in `apps/desktop/src/main/teams-client.ts`. Point it somewhere else with the
`GLYPHI_TEAMS_API` environment variable.

## Self-hosting the backend

```
supabase/
  migrations/0001_teams_schema.sql        accounts, sessions, teams, memberships, daily usage
  functions/glyphi-teams-api/index.ts     the only door: auth, teams, invites, usage, sharing
```

The schema is locked the same way as the single-player one: everything lives in the `teams` schema with RLS
enabled and no policies, every `teams_api_*` function is revoked from `anon` and `authenticated`, and only the
Edge Function's `service_role` reaches the data. Passwords are hashed with bcrypt inside the database
(`crypt` / `gen_salt('bf')`), and session tokens are stored as SHA-256 hashes, so a database leak cannot be
replayed against the API.

To recreate it on your own project:

```bash
supabase db push --project-ref <ref>
supabase functions deploy glyphi-teams-api --project-ref <ref> --no-verify-jwt
```

Nothing else is required: `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are injected into the function by the
platform.

## API

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/api/auth/sign-up` | Create an account, returns a session token |
| `POST` | `/api/auth/sign-in` | Exchange email + password for a session token |
| `GET` | `/api/auth/get-session` | Who the token belongs to |
| `POST` | `/api/auth/sign-out` | Revoke the token |
| `GET` | `/api/teams` | Every team the account belongs to, with members and totals |
| `POST` | `/api/teams` | Create a team (owner only by construction) |
| `POST` | `/api/teams/join` | Join with an invite code |
| `POST` | `/api/teams/usage` | Push daily aggregates (`{ days: [{ day, tokens, costMicros, tools }] }`) |
| `POST` | `/api/teams/sharing` | Turn sharing on or off for one team |
| `POST` | `/api/teams/members/remove` | Remove a member (owner), or leave |

## License

MIT © 2026 Arthur Godart.

## The manager window

The Teams edition is the app plus a manager surface. Sign in with a Teams account
(an email and a password in your own backend — no Glyphi handle), create the team,
and the window gives you:

- **The board** — every member with tokens, 7-day totals, cost, active days and
  their sharing switch. A member who turns sharing off keeps their row and loses
  their numbers; the rows already shared are deleted.
- **A daily token cap per member** (`POST /api/teams/limits`). The manager sets it,
  the board flags whoever crosses it, and zero clears the cap.
- **Encrypted team chat** (`/api/teams/messages`). Messages are sealed in the app
  with AES-256-GCM under a key derived from the invite code with PBKDF2-SHA256;
  the server stores ciphertext and an IV and holds no key. The invite code never
  leaves the machine that created or joined the team.
- **The invite QR** — the code as a QR image with the app mark in the centre. Error
  correction is set to `H`, so covering the middle costs no redundancy.
- **Your logo** — Settings → Appearance takes a PNG, and the window, the invite
  card and the QR wear it.

Everything the app sends is a day total or ciphertext. Nothing is stored by Glyphi
Teams: the backend runs in the company's own Supabase project.

## Counting proxy

The Teams build ships the same Rust proxy as Glyphi and starts it with the app: it
listens on `127.0.0.1:4787`, forwards each request to the real provider and counts
what the provider reports. A member whose tool writes nothing readable still shows
up in the manager's totals.

Point an agent at it once, with the provider name in the path:

```
OPENAI_BASE_URL=http://127.0.0.1:4787/p/openai
ANTHROPIC_BASE_URL=http://127.0.0.1:4787/p/anthropic
OPENAI_BASE_URL=http://127.0.0.1:4787/p/ollama      # a local runtime
```

83 providers are known by name; any other endpoint works with an explicit upstream
(`.../p/my-gateway/v1/chat/completions?upstream=https://gateway.example.com/v1`) or
an entry in `providers.json` next to the binary:

```json
{ "my-gateway": "https://gateway.example.com/v1" }
```

The manager reads `GET /__glyphi/usage` and shows it as one more source beside the
local history: today's input, output and a line per provider — the twelve busiest
named, the rest summed, so the sixteen-metric contract never breaks. `GET
/__glyphi/health` says whether the proxy is up, `GET /__glyphi/providers` lists the
names it knows.

It listens on loopback only, keeps no credential (each request carries its own
`Authorization`), stores nothing but one JSON line per request in the app data
folder, and uses about 6 MB of RAM. It cannot read traffic it did not route: a
client that hardcodes its endpoint would need TLS interception, which means a root
certificate on the machine, and that is not a trade this project makes.

## Builds and installers

The application is packaged with electron-forge. One command builds the
distributables for the OS you run it on:

```
npx bun@1.3.14 run desktop:make
```

- **Windows** — `out/make/squirrel.windows/x64/Glyphi-<version> Setup.exe` (Squirrel) plus a portable `zip/win32/x64/`.
- **macOS** — `out/make/dmg/` and `zip/darwin/`; must be run on macOS.
- **Linux** — `out/make/appimage/` and `out/make/deb/`; run on Linux.

Then sign what can be signed:

```
npx bun@1.3.14 run sign:builds
```

- **Windows** — the packaged app and the Squirrel setup get an Authenticode signature from a code-signing certificate in the current user's store. When none exists, the script creates a self-signed `CN=Glyphi Teams` key (5 years) and signs with it. A self-signed signature is *not* trusted: Windows keeps showing the SmartScreen warning until a certificate from a certificate authority replaces that key, so treat this as a build integrity check, not as trust.
- **Linux** — every AppImage, deb and rpm gets a detached GPG signature (`.asc`) from the `GLYPHI_GPG_KEY` user, defaulting to `Glyphi Teams`. Nobody can verify it until that public key is published.
- **macOS** — shipped unsigned on purpose: Apple needs a paid Developer ID and a notarisation round-trip, so the DMG is not signed and the first launch needs a right-click then Open.
