# Moving Glyphi Teams off Electron

Electron costs a user roughly 250–350 MB of RAM for this interface, plus a 140 MB
installer that carries a whole Chromium and a Node runtime. The Rust shell uses
the WebView the operating system already ships, and the counting proxy is a 5 MB
process with no runtime at all. That is the whole reason for the migration.

## What exists now

| Piece | State |
| --- | --- |
| `crates/glyphi-proxy` | **Built and tested.** Counting proxy, 83 providers, word-count fallback, JSONL log, `/__glyphi/usage`. 5.9 MB RSS idle. |
| `apps/desktop-rs` | **Scaffolded, not built.** Tauri v2 shell, starts the proxy as a sidecar, `com.glyphi.teams` identifier, same icons. |
| Renderer | Unchanged. Tauri loads the same React bundle; no rewrite needed. |

## Order of work

1. **Window** — `tauri dev` serving the existing renderer over `frontendDist`, with
   the `window.glyphi` API reimplemented as Tauri commands.
2. **History database** — rusqlite over the same `history.sqlite` schema, so an
   existing install keeps its data.
3. **Provider readers** — ported one by one from `apps/desktop/src/engine/providers`,
   each with the Rust test that matches the existing TypeScript test.
4. **Proxy integration** — the usage cards read `/__glyphi/usage` in addition to the
   local files, which is how a provider with no on-disk trace (Freebuff) finally
   reports something.
5. **Shell features** — tray, single instance, auto-update (Tauri updater), deep
   links, notifications.
6. **Packaging** — MSI/NSIS on Windows, dmg on macOS, AppImage/deb on Linux; the
   Electron makers are retired only once the Rust build passes the same smoke test.

## The proxy

```
cargo build --release -p glyphi-proxy
./glyphi-proxy
```

An agent points its base URL at it:

```
OPENAI_BASE_URL=http://127.0.0.1:4787/p/openai
ANTHROPIC_BASE_URL=http://127.0.0.1:4787/p/anthropic
```

Any name not in the built-in list still works with an explicit upstream:
`http://127.0.0.1:4787/p/my-gateway/v1/chat/completions?upstream=https://gateway.example.com/v1`.

Read the totals at `http://127.0.0.1:4787/__glyphi/usage`, or read the append-only
`proxy-usage.jsonl` in `%APPDATA%\Glyphi Teams`.

### What the proxy cannot see

Traffic it did not route. A client that hardcodes its endpoint (the Freebuff
desktop app talks only to `codebuff.com`) needs TLS interception, which means
installing a root certificate on the user's machine. That is not worth the trust
it costs, so Freebuff keeps using the cloud quota endpoint when a token is
available and reports "nothing measured" when it is not.
