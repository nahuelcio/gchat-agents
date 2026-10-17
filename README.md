# Switchboard

Talk to local coding agents — [OpenCode](https://github.com/opencode-ai/opencode) or [Claude Code](https://claude.com/claude-code) — from **Google Chat**.

A Google Chat App receives messages in DMs and spaces, this service drives `opencode` headlessly on your machine, and the agent's answer is posted back into the same Chat thread. Local-first: the agent, its files, and its sessions never leave the machine where this runs.

```
 Google Chat                       your machine
┌──────────────────┐   HTTPS   ┌─────────────────────────────┐
│ Chat App (bot)   ├──────────►│ POST /google/chat           │
│ space / DM       │           │  1. verify Google token     │
│                  │           │  2. allowlist check         │
│ thread = session │◄──────────┤  3. queue turn (per thread) │
└──────────────────┘  REST API │  4. agent CLI (headless)    │
                        ▲      │  5. post reply in thread    │
                        └──────┤ service account + chat.bot  │
                               └─────────────────────────────┘
```

One Chat thread = one opencode session. New thread, fresh session.

## How it drives agents

One Chat thread = one agent session. New thread, fresh session. Pick the runtime with `AGENT_DRIVER`:

| Driver | Headless command | Session continuation |
| --- | --- | --- |
| `opencode` (default) | `opencode run --format json [--session ses_...] -- "msg"` | `--session` continues the session **or creates it** (v2.0.26) |
| `claude` | `claude -p --output-format json [--resume <uuid>] -- "msg"` | `--resume` with the UUID from the previous turn (v2.1.296) |

Details that the drivers handle for you:

- **`--` before the message** — text starting with `-` would otherwise be eaten as CLI flags (verified on both CLIs).
- **Session-ref guarding** — each driver only resumes refs in its own format; a thread started with one driver and switched to the other starts a fresh session instead of failing.
- **Output parsing** — opencode emits NDJSON text parts; claude emits a single result JSON where `is_error` is the only reliable error signal (`subtype` can say `"success"` on failures — verified live).
- **Headless permission posture** — opencode gets no auto-approve flag; claude headless auto-denies anything that would prompt. Both answer chat/read work without granting write/exec from a chat message.
- **Timeouts** — the whole agent process group is SIGKILLed; agents spawn background children that would otherwise linger.

## Setup

### 1. Google Cloud

1. Create a project, enable the **Google Chat API**.
2. Create a service account, download the JSON key, note the project **number**.
3. Configure the Chat App:
   - Name, avatar, description.
   - Connection: **HTTP endpoint URL** = `https://<your-public-host>/google/chat`
   - Authentication audience: the same **HTTP endpoint URL** (or switch to **Project number** — `GOOGLE_TOKEN_AUDIENCE` below must match whichever you pick).
   - Enable **Direct messages** and/or **Spaces** as needed.

### 2. Run it

**Without cloning (prebuilt binary, UI included):**

```
irm https://raw.githubusercontent.com/nahuelcio/gchat-agents/main/scripts/install.ps1 | iex   # Windows
curl -fsSL https://raw.githubusercontent.com/nahuelcio/gchat-agents/main/scripts/install.sh | sh   # Linux / macOS
```

While the repo is private, run the script from a machine with `gh auth login` done (it downloads through `gh`). Releases are built by `.github/workflows/release.yml` on every `v*` tag.

The public tunnel is picked in Settings › Public tunnel (`auto` uses cloudflared on Windows, downloaded on first use; opentunnel elsewhere). `TUNNEL` in `.env` overrides it.

**From the repo:**

**Windows (PowerShell or cmd), from the repo root:**

```
npm install --include=dev
npm start
```

That builds the control-plane UI and runs the Rust binary. Open `http://127.0.0.1:8081`.

Dev (backend + UI hot reload + tunnel), or `npm run dev:echo` without an agent CLI:

```
npm run dev
```

Production runtime is the Rust binary (`rust/`). Node is only used to build the control-plane UI. Nothing is required to start: without credentials the playground and control plane work and Chat replies are off. To answer in Google Chat, set `GOOGLE_SERVICE_ACCOUNT_JSON` in `.env`.

Then open `http://127.0.0.1:8081` to pick the agent, add repos and allow spaces. Add the bot to a space or DM it.

## Environment

| Key | Meaning |
| --- | --- |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | Needed to answer in Chat (the bridge starts without it). Service account key (file path or base64 JSON), used to post replies (`chat.bot` scope) |
| `TUNNEL` | `on` (default) exposes the bridge with opentunnel at startup; `off` to bring your own HTTPS front |
| `GOOGLE_TOKEN_AUDIENCE` | Expected token audience. Default with the tunnel on: `<tunnel URL>/google/chat`. Required with `TUNNEL=off` (endpoint URL or project number, matching the Chat app setting) |
| `PORT` / `ADMIN_PORT` | Bridge port (default 8080) / control plane port, loopback only (default 8081) |
| `AGENT_WORKDIR` | Where chat-only threads run the agent (default `data/workspace`). `/repo a b c` gives a thread one worktree per repo under one folder; `/status`, `/up [repo]`, `/down`, `/logs`, `/close [repo]` manage them |
| `DATA_DIR` | Settings, sessions, schedules, worktrees, clones (default `./data`) |
| `AGENT_TURN_TIMEOUT_MS` | Max turn duration (default 600000) |

Everything else — agent, models, repos, spaces, context footer — lives in the control plane. `AGENT_DRIVER`, `OPENCODE_MODEL`, `CLAUDE_MODEL`, `CHAT_ALLOWED_SPACES`, `AGENT_REPOS_FILE`, `OPENCODE_BIN` and `CLAUDE_BIN` still work as first-run seeds.

## Security

This endpoint **triggers an agent that executes code on this machine**. Take it seriously:

- Every event must carry a Google-signed bearer token; it is verified against your audience and `chat@system.gserviceaccount.com` before anything runs. Verified tokens from any other source fail with 401.
- The space allowlist drops events from unlisted spaces with no agent run. Keep it tight.
- `AGENT_WORKDIR` (default `data/workspace`) is the blast radius for chat-only threads; it is never the bridge's own checkout.
- In spaces, only @mentions reach the app. In DMs, every message does — DM the bot only to people you trust with the machine.
- Replies are posted with a service account restricted to the `chat.bot` scope; no user credentials, no domain-wide delegation.

## Development

```
npm install
npm test               # cargo test
npm run e2e            # build debug binary + healthz /api contract
npm run dev            # echo driver on :8080 / :8081
npm run build:web      # control plane UI (vite)
npm run dev:web        # UI only (needs bridge already on :8081)
npm run test:browser   # browser e2e (tester-army/e2e) against the real binary, echo driver
E2E_DRIVER=opencode npx e2e run e2e/rooms.e2e.ts --workers 1   # rooms with real opencode agents
```

## Layout

```
rust/              production backend (axum + tokio)
  src/
    main.rs        binary entry (loads .env, serves bridge + admin)
    bridge.rs      /healthz, /google/chat
    admin.rs       /api/* control plane (loopback)
    handler.rs     auth → allowlist → per-thread queue → driver
    driver/        echo, opencode, claude, spawn+timeout
    session.rs     sessions.json atomic store
    settings.rs    config.json
    schedules.rs   cron + job store + scheduler
    workspace.rs   git worktrees / app up
    share.rs       share-token
web/               control-plane UI (React + Vite) — unchanged
src/               legacy TypeScript backend (retired from runtime)
```

Another runtime (Codex, Cursor, …) means writing one more `AgentDriver` adapter in `rust/src/driver/` — nothing else changes.

## Status

MVP. Works: DM + space mentions, thread-per-session, async replies, chunked output, timeouts, allowlist, OpenCode and Claude Code drivers. Thread commands with per-thread worktrees and dev servers. Not yet: ADO work items, cards, attachments, approval gate before the agent writes.
