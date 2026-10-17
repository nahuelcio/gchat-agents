# gchat-agents

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

```
npm install --include=dev        # --include=dev matters if your shell sets NODE_ENV=production
npm i -g opentunnel              # public HTTPS URL for the bridge (blind TLS: the relay never sees plaintext)
npm start                        # build + tunnel + bridge + control plane
```

Nothing is required to start: without credentials the playground and control plane work and Chat replies are off. To answer in Google Chat, set `GOOGLE_SERVICE_ACCOUNT_JSON` in `.env`. `npm start` prints the public endpoint (also shown in the control plane, with a Copy button): paste it as the Chat app's **HTTP endpoint URL**, with the authentication audience set to that same URL. The URL is stable across restarts: `opentunnel route add` reuses the route for the port.

Then open `http://127.0.0.1:8081` to pick the agent, add repos and allow spaces. Add the bot to a space or DM it.

## Environment

| Key | Meaning |
| --- | --- |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | Needed to answer in Chat (the bridge starts without it). Service account key (file path or base64 JSON), used to post replies (`chat.bot` scope) |
| `TUNNEL` | `on` (default) exposes the bridge with opentunnel at startup; `off` to bring your own HTTPS front |
| `GOOGLE_TOKEN_AUDIENCE` | Expected token audience. Default with the tunnel on: `<tunnel URL>/google/chat`. Required with `TUNNEL=off` (endpoint URL or project number, matching the Chat app setting) |
| `PORT` / `ADMIN_PORT` | Bridge port (default 8080) / control plane port, loopback only (default 8081) |
| `AGENT_WORKDIR` | Where chat-only threads run the agent (default `data/workspace`; threads with `/repo` use their worktree) |
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
npm run build          # tsc + control plane UI (vite)
npm run dev            # backend watch + control plane UI hot reload (open :5173)
npm run dev:web        # UI only (needs bridge already on :8081)
npm test               # vitest
npm run smoke -- --driver echo   # end-to-end without Google or opencode
```

Each `--text` is one message in the same thread, so command flows run too:
`AGENT_REPOS_FILE=repos.json npm run smoke -- --driver echo --text "/repo web" --text "/up" --text "/logs"`.

The smoke script fabricates a Chat event and prints the reply instead of POSTing. Drop `--driver echo` to exercise the real `opencode` binary.

## Layout

```
src/
  server.ts        HTTP: /google/chat, /healthz, 1MB body cap
  verify.ts        Google token verification (URL-audience ID token / project-number JWT)
  handler.ts       event -> auth -> allowlist -> queue -> driver -> reply
  queue.ts         serial per-thread turn queue
  store.ts         thread -> opencode session map (atomic JSON writes)
  text.ts          mention stripping, 3800-char chunking
  chat-client.ts   Google Chat REST poster (service account, chat.bot)
  workspace.ts     per-thread git worktrees and dev-server processes
  settings.ts      control-plane settings (validated, atomic writes)
  agents.ts        detects installed coding agents and opencode models
  schedules.ts     cron parser, job store, scheduler with retries
  health.ts        uptime, starts, crash count, heartbeat
  admin.ts         control-plane JSON API + static UI on 127.0.0.1
  integrations.ts  Azure DevOps (ado CLI detection, projects/repos, clone)
web/               control-plane UI (React + Vite)
  driver/
    types.ts        AgentDriver seam
    spawn-capture.ts shared spawn+timeout+process-group-kill helper
    opencode.ts     OpenCode adapter (spawns opencode CLI)
    claude.ts       Claude Code adapter (spawns claude CLI)
    echo.ts         canned driver (tests, smoke)
    configured.ts   picks driver/model from settings each turn
```

Another runtime (Codex, Cursor, …) means writing one more `AgentDriver` adapter — nothing else changes.

## Status

MVP. Works: DM + space mentions, thread-per-session, async replies, chunked output, timeouts, allowlist, OpenCode and Claude Code drivers. Thread commands with per-thread worktrees and dev servers. Not yet: ADO work items, cards, attachments, approval gate before the agent writes.
