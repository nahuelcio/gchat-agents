# Switchboard

Talk to a local [Pi Durable](https://earendil.com/posts/pi-durable/) agent from **Google Chat**.

A Google Chat App receives messages in DMs and spaces, this service runs Pi headlessly on your machine (via `harness/`), and the agent's answer is posted back into the same Chat thread. Local-first: the agent, its files, and its sessions never leave the machine where this runs.

```
 Google Chat                       your machine
┌──────────────────┐   HTTPS   ┌─────────────────────────────┐
│ Chat App (bot)   ├──────────►│ POST /google/chat           │
│ space / DM       │           │  1. verify Google token     │
│                  │           │  2. allowlist check         │
│ thread = session │◄──────────┤  3. queue turn (per thread) │
└──────────────────┘  REST API │  4. Pi harness (durable)    │
                        ▲      │  5. post reply in thread    │
                        └──────┤ service account + chat.bot  │
                               └─────────────────────────────┘
```

One Chat thread = one Pi session. New thread, fresh session.

## How it drives agents

The production runtime is **Pi only**. Switchboard starts `harness/server.ts` (Node 22.19+) by itself; turns survive restarts and crashes, a repeated message never runs twice, and a `bash` cut by a crash is reported to the model instead of run again. Set the model as `provider/model` with that provider's API key in `.env` (for example `ANTHROPIC_API_KEY`). `PI_HARNESS=off` disables the harness; `PI_PORT` moves it. `AGENT_DRIVER=opencode|claude` in env is accepted only as a legacy seed and coerced to Pi.

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

Dev (backend + UI hot reload + tunnel), or `npm run dev:echo` without a live model:

```
npm run dev
```

Production runtime is the Rust binary (`rust/`). Node builds the control-plane UI and runs the Pi harness. Nothing is required to start: without credentials the playground and control plane work and Chat replies are off. To answer in Google Chat, set `GOOGLE_SERVICE_ACCOUNT_JSON` in `.env`.

Then open `http://127.0.0.1:8081` to pick the model, add repos and allow spaces. Add the bot to a space or DM it.

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
| `PI_HARNESS` / `PI_PORT` | `off` disables the Pi sidecar; port override for the harness |

Everything else — model, repos, spaces, personas, skills, MCP (Engram defaults on), context footer — lives in the control plane. `CHAT_ALLOWED_SPACES` and `AGENT_REPOS_FILE` still work as first-run seeds.

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
npm run dev            # rust + vite hot reload
npm run build:web      # control plane UI (vite)
npm run dev:web        # UI only (needs bridge already on :8081)
npm run test:browser   # browser e2e (tester-army/e2e) against the real binary, echo driver
npx e2e run e2e/pi.e2e.ts --workers 1   # Pi harness rooms (needs API keys)
```

Agents are a persona plus skills plus tools. A skill is `data/skills/<name>/SKILL.md` (or `skills/<name>/SKILL.md` in this repo) with `name`, `description` and `mcps` in the frontmatter; its text goes into the agent's instructions and its `mcps` turn on by themselves. Settings can **Generar / Mejorar** personas and skills with AI. If `engram` is installed it is registered automatically (opt out by removing it under Skills & tools). The Finance example: create a persona with the `finanzas` skill, set the Drive folder id in Settings › Google Drive, and share that folder with the service account email as Editor.

Agent-first CLI over the local control plane (JSON in, JSON out, errors as `{"error": ...}` with exit 1):

```
switchboard json                                   # lists verbs
switchboard json activity --limit 20 --kind turn_fail
switchboard json search --q "token de meta"
echo '{"text":"hola","name":"bot"}' | switchboard json thread send --thread T --stdin
switchboard json approvals decide --id ab12 --approve
```

## Layout

```
rust/              production backend (axum + tokio)
  src/
    main.rs        binary entry (loads .env, serves bridge + admin)
    bridge.rs      /healthz, /google/chat
    admin.rs       /api/* control plane (loopback)
    handler.rs     auth → allowlist → per-thread queue → driver
    driver/        echo, pi, spawn+timeout
    session.rs     sessions.json atomic store
    settings.rs    config.json (Pi-only, templates, Engram defaults)
    schedules.rs   cron + job store + scheduler
    workspace.rs   git worktrees / app up
    share.rs       share-token
harness/           Pi Durable sidecar (started by Rust)
web/               control-plane UI (React + Vite)
src/               legacy TypeScript backend (retired; npm start → Rust)
```

## Status

MVP. Works: DM + space mentions, thread-per-session, async replies, chunked output, timeouts, allowlist, Pi Durable driver, personas + skill packs + Engram, AI draft in Settings. Thread commands with per-thread worktrees and dev servers. Not yet: ADO work items, cards, attachments, approval gate before the agent writes.
