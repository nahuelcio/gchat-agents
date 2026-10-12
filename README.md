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

### 2. Expose the endpoint

The service only needs to be reachable by Google. Easiest local-first option is a Cloudflare Tunnel:

```
cloudflared tunnel --url http://localhost:8080
```

Any HTTPS front (nginx, Caddy, a PaaS) works the same way.

### 3. Configure and run

```
cp .env.example .env   # fill in every key, then:
npm install
npm run build
node dist/index.js     # or: npm run build && node --env-file=.env dist/index.js
```

Add the bot to a space or DM it. First message in a thread starts a session; replies land in the same thread.

## Environment

| Key | Meaning |
| --- | --- |
| `PORT` | HTTP port (default 8080) |
| `GOOGLE_TOKEN_AUDIENCE` | Expected token audience: your endpoint URL **or** the project number — must match the Chat app setting |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | Service account key (file path or base64 JSON), used to post replies (`chat.bot` scope) |
| `CHAT_ALLOWED_SPACES` | Comma-separated allowlist (`spaces/AAA,spaces/BBB`); anything else is dropped |
| `AGENT_DRIVER` | Agent runtime: `opencode` (default) or `claude` |
| `AGENT_WORKDIR` | Directory the agent works in — use a dedicated one |
| `OPENCODE_BIN` | opencode binary (default `opencode`) |
| `OPENCODE_MODEL` | Optional opencode model override, `provider/model#variant` |
| `CLAUDE_BIN` | claude binary (default `claude`) |
| `CLAUDE_MODEL` | Optional Claude Code model override |
| `AGENT_TURN_TIMEOUT_MS` | Max turn duration (default 600000) |
| `DATA_DIR` | Where `sessions.json` lives (default `./data`) |

## Security

This endpoint **triggers an agent that executes code on this machine**. Take it seriously:

- Every event must carry a Google-signed bearer token; it is verified against your audience and `chat@system.gserviceaccount.com` before anything runs. Verified tokens from any other source fail with 401.
- The space allowlist drops events from unlisted spaces with no agent run. Keep it tight.
- `AGENT_WORKDIR` is the blast radius for file operations. Point it at a dedicated directory, not `$HOME`.
- In spaces, only @mentions reach the app. In DMs, every message does — DM the bot only to people you trust with the machine.
- Replies are posted with a service account restricted to the `chat.bot` scope; no user credentials, no domain-wide delegation.

## Development

```
npm install
npm run build          # tsc
npm test               # vitest, 37 tests
npm run smoke -- --driver echo   # end-to-end without Google or opencode
```

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
  driver/
    types.ts        AgentDriver seam
    spawn-capture.ts shared spawn+timeout+process-group-kill helper
    opencode.ts     OpenCode adapter (spawns opencode CLI)
    claude.ts       Claude Code adapter (spawns claude CLI)
    echo.ts         canned driver (tests, smoke)
```

Another runtime (Codex, Cursor, …) means writing one more `AgentDriver` adapter — nothing else changes.

## Status

MVP. Works: DM + space mentions, thread-per-session, async replies, chunked output, timeouts, allowlist, OpenCode and Claude Code drivers. Not yet: slash commands, cards, attachments, multi-agent routing.
