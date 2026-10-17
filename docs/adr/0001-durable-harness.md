# ADR 0001 — Switchboard durable harness

Status: accepted · 2026-10-17

## Context

Switchboard bridges Google Chat and the team chat to coding agents. Today every agent turn spawns a CLI (`opencode` or `claude`). The bridge persists sessions, transcripts, schedules, settings, media and activity, but a turn in flight lives only in memory: who is speaking, a parked question with its live child process, a room stop request, the per-thread queue and the child process itself. A crash or restart loses all of it, and Google retrying a webhook can produce a second reply.

We also want agents defined by role, not by code: a persona plus skills plus MCP tools (first case: a Finance agent that creates an `.xlsx` in a shared Google Drive folder).

Pi Durable showed the shape of a durable agent runtime (checkpointed tasks, replay rules, request ids, steer, compaction). We take its ideas, not its code.

## Decision

1. **Keep the CLIs.** `opencode` stays the default; `claude` stays. The harness is one more driver, `AgentDriverKind::Switchboard`, behind the existing `AgentDriver::run_turn` facade and routed by `ConfiguredDriver`.
2. **Own runtime in Rust.** The harness lives in `rust/src/harness/`. No dependency on Pi, no TypeScript copy.
3. **One process owns storage.** A single SQLite file, `DATA_DIR/harness.sqlite`, guarded by a file lock. Tests use in-memory SQLite.
4. **A conversation is a thread.** Conversation id = existing `thread_key` (`{thread_key}#{persona}` for personas). Moving the thread folder archives the conversation and opens a new one.
5. **The UI keeps reading transcripts.** The harness mirrors committed entries one-way into `TranscriptStore`. SQLite is the source of truth.
6. **Agents = persona + skills + MCPs.** A skill is `data/skills/<name>/SKILL.md` (frontmatter `name`, `description`, `mcps`). Builtin MCPs (`switchboard`, `google-drive`) have one Rust implementation, called in-process by the harness and over stdio by the CLIs. External MCPs are a configured stdio command.
7. **First provider is OpenAI-compatible HTTP**, then Anthropic. A fake provider is mandatory in tests.

## Primitives

| Primitive | Meaning |
|---|---|
| Task with checkpoint | `ModelTurn`, `ToolCall`, `Compact`; each phase commits before advancing |
| `requestId` | Chat `message.name`, team message id, or `schedule:{id}:{fireAt}`; a repeat returns the existing submission |
| Replay | `read` is `safe` (re-run); `bash`, `write`, `edit` are `none` (resume writes an *interrupted* result) |
| Ownership | tool-created child conversations abort bottom-up with their task |
| Foreground / background | foreground belongs to the turn and stops with `/stop`; background survives the turn (product phase) |
| Documents | typed JSON committed with the transcript entry (todos, plan, work item) |
| Registry | tools and sections by name; storage keeps names, never code |
| Memo | first write wins, so a hook does not ask twice after restart |
| Steer | a submit while busy lands after the current tool calls |
| Compact | summary task over a fixed entry range; old entries are kept |

## Crash semantics

- `ModelTurn` cut mid-request is re-sent; a partial stream is marked aborted, never reused.
- Safe tool: re-run. Unsafe tool: commit *interrupted* with committed output; two crashes never run it twice.
- `Compact`: re-run on the same range from the checkpoint.
- Timers (`wake_at`) survive restart. `resume()` on open continues every non-terminal task without waiting for new input.
- Ordered shutdown and `kill -9` resume the same way.
- Before the harness, the CLI path gets a turn ledger: duplicate `requestId` does not post twice; a turn running at restart is marked failed and announced once, never relaunched; a parked question expires once.

## Permissions

Tools run in an `ExecutionEnv` rooted at the thread folder (`AGENT_WORKDIR` or the multi-repo thread folder). Paths escaping it fail before running. `bash` gets a timeout, a process-group kill and an env without bridge secrets. The allowlist is per agent: Finance gets only its MCP tools and `ask_user`; a code agent gets `read`/`write`/`edit`/`bash` and the `switchboard` MCP.

## Google Drive

Same service account, separate token with `drive.file` scope, fixed folder id in settings, no domain-wide delegation. `create_xlsx` tags files with `appProperties.switchboardTaskId` and looks it up before uploading, so a retry or a resume never creates a second file. If the folder is not shared with the service account the tool fails with that error.

## Not doing

- Depend on Pi, port its code, or its Bun/Cloudflare adapters.
- Rewrite the bridge, Google verification, tunnel or UI.
- Several processes or hosts on one SQLite.
- Remote VMs for tools.
- Auto-approve writes outside the thread folder; any deploy tool.
- Migrate old CLI transcripts into the harness.
- Handoff, subagents, approvals or automatic compaction in the first slice.
- A TypeScript harness.
- A skill marketplace or skills as executable code.
- Domain-wide delegation, user OAuth, native Google Sheets.
- Disabling `bash` inside the `claude`/`opencode` binaries (only the harness allowlist does that).

## Order

1. This ADR.
2. Turn ledger for the CLIs (H1).
3. Skills, MCPs and the Finance agent on the CLIs (H-finanzas).
4. Harness core up to H2: SQLite, tasks, `read`/`bash`, request ids, manual compact, driver, mirror.
5. Product edges one at a time up to H3/H4: chat steer, mixed rooms, durable `ask_user`, schedules, cwd moves, builtin tools, media, room stop.
6. Automatic compaction, documents, live stream (H5).
7. The default stays `opencode`; switching it is a separate decision.
