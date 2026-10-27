# Switchboard

Talk to a team of local AI agents from **Google Chat**.

Switchboard is a single binary that connects a Google Chat app to [Pi Durable](https://earendil.com/posts/pi-durable/) agents running on your own machine. Message the bot in a DM or mention it in a space; the agent works on your machine — with your repos, tools and memory — and replies in the same thread.

- **Local-first.** The agent, its files and its sessions never leave the machine it runs on.
- **Durable.** Turns survive restarts and crashes; a repeated message never runs twice.
- **A team, not a bot.** Several agents share a room, hand work to each other and answer when it is their turn.
- **Batteries included.** 23 ready-made agents, 27 skills and a 19-server MCP catalog ship inside the binary.

```
 Google Chat                       your machine
┌──────────────────┐   HTTPS   ┌─────────────────────────────┐
│ Chat App (bot)   ├──────────►│ POST /google/chat           │
│ space / DM       │           │  1. verify Google token     │
│                  │           │  2. allowlist check         │
│ thread = session │◄──────────┤  3. queue turn (per thread) │
└──────────────────┘  REST API │  4. Pi harness (durable)    │
                               │  5. post reply in thread    │
                               └─────────────────────────────┘
```

One Chat thread is one session. A new thread starts fresh.

## Quick start

**1. Install the prebuilt binary** (the control-plane UI is included):

```sh
# Windows (PowerShell)
irm https://raw.githubusercontent.com/nahuelcio/gchat-agents/main/scripts/install.ps1 | iex

# Linux
curl -fsSL https://raw.githubusercontent.com/nahuelcio/gchat-agents/main/scripts/install.sh | sh
```


**2. Run `switchboard`** (new terminal on Windows) and open `http://127.0.0.1:8081`, pick a model and add a provider API key.

**3. Try it without Google Chat.** The playground and control plane work with no credentials. To reply in Chat, follow [Connect Google Chat](#connect-google-chat).

## What ships in the box

Everything below is embedded in the binary and appears on first start. Nothing is downloaded until an agent uses it.

### Agents

Apply a template in **Agents** to create the agent; edit it freely afterwards.

| Area | Agents |
| --- | --- |
| Research | **Researcher** (multi-source web research with citations), **Strategist** (vendor and product comparisons), **Tutor** |
| Web | **Browser** (drives a real browser), **Frontend**, **Designer** (Figma to UI), **Perf** (DevTools and Lighthouse) |
| Code | **Reviewer**, **Debugger**, **Architect**, **QA**, **APIDesigner**, **DotNet**, **RepoGuide** (explains any repo) |
| Ops | **SRE** (incidents and postmortems), **DevOps**, **Security**, **DBA** |
| Product | **PM** (specs and work items), **Analyst** (data), **Scribe** (minutes and release notes), **Writer**, **Prompter** |

Templates you never edited are updated automatically when a new version ships; edited ones are left alone. Delete one and it stays deleted.

### Skills

A skill is a `SKILL.md` with step-by-step instructions that an agent loads when a task matches. Bundled:

`deep-research` · `fact-check` · `browser-automation` · `ui-polish` · `test-plan` · `tdd` · `code-review` · `diagnosing-bugs` · `codebase-design` · `improve-codebase-architecture` · `domain-modeling` · `grilling` · `security-audit` · `incident-response` · `sql-review` · `api-design` · `data-analysis` · `product-spec` · `competitive-analysis` · `prompt-engineering` · `meeting-notes` · `release-notes` · `writing-for-agents` · `teach` · `retro` · `artifacts` · `skill-creator`

Add your own under `data/skills/<name>/SKILL.md`, or create and improve them with AI in **Agents**.

### MCP servers

Registered automatically when their runtime is available (remove one in **Settings › Tools** to opt out):

| Server | What it gives agents |
| --- | --- |
| `engram` | Persistent memory across sessions |
| `context7` | Up-to-date library and API docs |
| `playwright` | A real browser (isolated profile, output kept out of your repos) |
| `exa` | Web search and page fetch, no API key needed |

One click away in **Settings › Tools › MCP catalog** (applying a template adds the keyless ones it needs):

| No key | Sign in on first use | API key or token |
| --- | --- | --- |
| DeepWiki, Microsoft Learn, Cloudflare Docs, Sequential Thinking, Chrome DevTools, Kubernetes | Azure DevOps, Linear, Sentry | GitHub, Grafana (read-only), Notion, Brave Search, Tavily, Firecrawl, Figma, Supabase (read-only), MongoDB (read-only), HubSpot |

Any other stdio MCP server can be added by hand or by pasting a Claude or Cursor `mcp.json`. **Check** starts each server and shows its tools, or why it fails (missing runtime, empty key).

### pi.dev packages

Browse, search and install extensions from [pi.dev/packages](https://pi.dev/packages) in **Settings › Tools**, most popular first, or paste a GitHub repo. On first start Switchboard installs [pi-mcp-adapter](https://github.com/nicobailon/pi-mcp-adapter) and [pi-claude-code](https://github.com/earendil-works/pi-claude-code). The adapter's `mcp` tool is pointed at the MCP servers in Settings (it does not read `~/.pi` or Cursor configs). pi-claude-code uses the `claude` CLI already on this machine; sign in with `claude auth login`. Remove either package in Settings and it stays removed. Their tools become a `pi-<name>` group you can give to agents, bundled skills are added to your skills, and a registered model provider appears in the model picker as `provider/model`. TUI pieces are ignored and listed as such.

## Connect Google Chat

1. In Google Cloud, create a project and enable the **Google Chat API**.
2. Create a service account, download its JSON key and note the project **number**.
3. Configure the Chat app:
   - **HTTP endpoint URL**: `https://<your-public-host>/google/chat`. The built-in tunnel gives you one; the control plane shows it.
   - **Authentication audience**: the same endpoint URL, or **Project number**. `GOOGLE_TOKEN_AUDIENCE` must match what you pick.
   - Enable **Direct messages** and/or **Spaces**.
4. Set `GOOGLE_SERVICE_ACCOUNT_JSON` in `.env` (file path or base64 JSON).
5. In the control plane, allow the spaces the bot may answer in. Then DM the bot or mention it in a space.

The public tunnel is chosen in **Settings › Connections**: `auto` uses cloudflared on Windows (downloaded on first use) and opentunnel elsewhere. `TUNNEL=off` lets you bring your own HTTPS front.

## Using it in Chat

- **Mention an agent** with `@Name`, or just describe the task and the host routes it.
- **Steer a running reply** by sending another message while the agent works.
- **Thread commands:** `/help`, `/status`, `/compact`, `/clear`, `/close`. `/repo a b c` gives the thread one worktree per repo; `/up`, `/down` and `/logs` manage their dev servers.
- **Schedules** run prompts on a cron and post the result into a thread.
- **Artifacts** turn long answers (reports, tables, plans) into a shareable page.
- **Attachments**: send images or files. Images reach the model directly; other files are saved and handed to the agent by path.
- **Approvals**: before a risky action (`git push`, `rm -rf`, `DROP TABLE`, deploys, MCP tools that delete or send, writes outside the thread's folder) the agent pauses and posts **Approve / Deny**. Reply `/approve <id>` or `/deny <id>`, or decide from Overview. Unanswered requests are denied after 10 minutes. Choose the level in **Settings › Chat › Approvals**.
- **Where it works**: every thread has a folder. Chat-only threads use `AGENT_WORKDIR`; `/repo <name or path>` pins a repo and gives the thread its own branch and worktree. Mention a local repo path and the bot offers to pin it. `/status`, Overview and the team chat side panel show the folder, who is working and every file and command touched.
- **Playground**: a share link (`/play#<token>`) lets you chat with the agents from a browser without Google Chat.

## Usage and cost

Overview shows cost and tokens for today, 7 or 30 days, per day, per agent and per thread, from `data/usage.jsonl`.

Agents can be exported as a JSON file (prompt, avatar, skills and the MCP servers they use, keys blanked) and imported on another machine from **Agents**.

## Configuration

Most settings live in the control plane: model, repos, allowed spaces, agents, skills, MCP servers, context footer and tunnel. Environment variables cover the rest:

| Key | Meaning |
| --- | --- |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | Service account key (file path or base64 JSON) used to post replies with the `chat.bot` scope. Without it, Chat replies are off. |
| `GOOGLE_TOKEN_AUDIENCE` | Expected token audience. Defaults to `<tunnel URL>/google/chat`; required with `TUNNEL=off`. |
| `TUNNEL` | `auto` (default), `cloudflared`, `opentunnel` or `off`. Overrides the setting. |
| `PORT` / `ADMIN_PORT` | Bridge port (default 8080) / control plane port, loopback only (default 8081). |
| `DATA_DIR` | Settings, sessions, schedules, skills, worktrees and clones (default `./data`). |
| `AGENT_WORKDIR` | Where chat-only threads run (default `data/workspace`). |
| `AGENT_TURN_TIMEOUT_MS` | Max turn duration (default 600000). |
| `PI_HARNESS` / `PI_PORT` | `off` disables the Pi sidecar / moves its port. |
| Provider keys | For example `ANTHROPIC_API_KEY`, or add keys in **Settings › Runtime**. |

`CHAT_ALLOWED_SPACES` and `AGENT_REPOS_FILE` still work as first-run seeds.

## Security

This endpoint **triggers an agent that runs code on this machine**. Treat it that way.

- Every event must carry a Google-signed bearer token, verified against your audience and `chat@system.gserviceaccount.com` before anything runs. Anything else gets a 401.
- The space allowlist drops events from unlisted spaces without running the agent. Keep it tight.
- In spaces only @mentions reach the app; in DMs every message does. Only let people you trust with the machine DM the bot.
- `AGENT_WORKDIR` is the blast radius for chat-only threads; it is never Switchboard's own checkout.
- Replies use a service account limited to `chat.bot`: no user credentials, no domain-wide delegation.
- Approvals stop risky commands and writes outside the thread's folder until someone in the thread says yes. Reads are not gated.
- Uploaded files other than raster images are served as downloads with a sandbox CSP, never rendered inline.
- The control plane has no login and listens on loopback only. Do not expose port 8081 beyond machines you trust.
- MCP catalog entries for databases and Grafana are read-only by default. Agent prompts require confirmation before destructive actions, but the real limit is the credentials you give each server.

## Development

Requires Rust stable and Node 22.19+.

```sh
npm install --include=dev
npm run dev            # backend + UI hot reload + tunnel
npm run dev:echo       # same, with an echo agent instead of a live model
npm start              # build the UI and run the release binary
npm test               # cargo test
npm run test:web       # UI unit tests
npm run e2e            # debug binary + /api contract
npm run test:browser   # browser e2e against the real binary (echo driver)
```

Releases are built by `.github/workflows/release.yml` on every `v*` tag, for Windows x64, macOS x64/arm64 and Linux x64/arm64.

To add bundled content:

- **Agent template**: `templates/<id>.json` (`id`, `name`, `prompt`, `skills`, `mcps`). Start `prompt` with a one-line summary; the host routes on the first 120 characters.
- **Skill**: `skills/<name>/SKILL.md` with `name`, `description` and optional `mcps` in the frontmatter.
- **Catalog MCP**: an entry in `catalog/mcps.json`. `{KEY}` placeholders in `args` and `env` are filled from its `inputs`.

`cargo test` checks that every template only uses bundled skills and known MCP servers, and that every catalog entry fills its inputs.

### Agent-first CLI

JSON in, JSON out over the local control plane; errors come back as `{"error": ...}` with exit code 1.

```sh
switchboard json                                   # list verbs
switchboard json activity --limit 20 --kind turn_fail
switchboard json search --q "token de meta"
echo '{"text":"hola","name":"bot"}' | switchboard json thread send --thread T --stdin
switchboard json approvals decide --id ab12 --approve
```

## Layout

```
rust/              backend (axum + tokio)
  src/
    main.rs        entry: CLI, MCP stdio server, or bridge + control plane
    bridge.rs      /healthz, /google/chat, /play
    admin.rs       /api/* control plane (loopback)
    handler.rs     auth → allowlist → per-thread queue → driver
    driver/        Pi and echo drivers
    personas.rs    team chat: routing, hand-offs, PASS
    settings.rs    config.json, bundled templates
    skills.rs      bundled and user skills
    mcp.rs         MCP proxy for agents
    mcp_client.rs  MCP servers, defaults and catalog
    schedules.rs   cron jobs
    workspace.rs   git worktrees and dev servers
harness/           Pi Durable sidecar (started by the binary)
web/               control-plane UI (React + Vite)
templates/         bundled agent templates
skills/            bundled skills (plus .agents/skills, synced from skills-lock.json)
catalog/           optional MCP catalog
```

## Status

Works: DMs and space mentions, thread-per-session, durable turns, team chat with several agents, bundled agents, skills and MCP catalog, schedules, artifacts, per-thread worktrees and dev servers, playground share links.

Works too: approvals with Chat cards, attachments, usage and cost, MCP health checks, pi.dev packages, agent export/import.

Not yet: multi-select question cards. Pi package commands and UI hooks (`registerCommand`, `on`) are captured on install and runnable from chat.
