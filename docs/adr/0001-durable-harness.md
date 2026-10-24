# ADR 0001 — Durable agent runtime: Pi Durable in a sidecar

Status: accepted · 2026-10-17 · updated 2026-10-23 (Pi 1.4.0)

## Context

Switchboard bridges Google Chat and the team chat to coding agents. Previously every turn spawned a short-lived CLI process; a turn in flight lived only in memory, so a crash or restart lost it, and Google retrying a webhook could produce a second reply.

[Pi Durable](https://earendil.com/posts/pi-durable/) (`@earendil-works/pi-durable`, MIT) is a durable agent runtime: every model request and tool call is a checkpointed task in SQLite, a repeated `requestId` returns the original submission, replay-safe tools rerun after a crash and the rest get an *interrupted* result. It is a TypeScript library for Node 22.19+, with no server and no MCP client of its own.

**History:** early drafts treated Pi as one more CLI-style driver beside OpenCode and Claude. Those CLIs were removed; production is Pi only. Legacy `AGENT_DRIVER=opencode|claude` seeds still coerce to Pi.

## Decision

1. **Use Pi Durable, do not reimplement it.** It runs in `harness/server.ts`, a small Node sidecar that embeds the library and owns `DATA_DIR/harness.sqlite`.
2. **Rust stays the bridge.** It starts the sidecar (`node --experimental-transform-types harness/server.ts`), restarts it if it exits, and talks to it over loopback HTTP (`PI_PORT`, default 8090): `POST /turn`, `POST /abort`, `GET /health`.
3. **`pi` is the only production driver.** `session_ref` holds the Pi conversation id. Echo remains for local smoke/tests.
4. **Exactly-once turns end to end.** The Rust turn ledger's request id is the Pi `requestId`; the sidecar maps each `requestId` to its conversation before submitting. On restart, unfinished turns on Pi are resubmitted with the same id and their answer is posted. The Pi driver retries a lost connection with the same id while the sidecar restarts.
5. **Tools.** Pi's `CodingTools` (`read`, `write`, `edit`, `bash`) plus Switchboard tools (`create_xlsx`, `list_spreadsheets`) that call the Rust admin. `create_xlsx` is `replay: "safe"` because Drive files are tagged with the task id. The tool list follows the agent's MCPs: `coding` → coding tools, `google-drive` → Drive tools; an agent without MCPs gets both.
6. **Models** come from pi-ai's catalog (`provider/model`, keys from the provider's env var). `PI_FAUX=1` swaps in a scripted provider for tests.
7. **Tool environment** gets the bridge env without secrets (anything named like a key, token, password or credential).

## Consequences

- Node 22.19+ is required for the production runtime.
- One sidecar process owns the SQLite file; Pi has no cross-process locking.
- On Windows a killed sidecar can leave a running `bash` child behind; Pi still never reruns it.
- Pi's API is marked experimental, so the dependency is pinned to the latest published release (`1.4.0` for `pi-durable`, `pi-ai`, `pi-codemode`, and `chord`). Settings reads that version from the installed package.

## Not doing

- Porting Pi to Rust or forking it.
- Running tools on remote machines.
- Migrating old CLI sessions into Pi.
- Bringing OpenCode or Claude CLI drivers back.
