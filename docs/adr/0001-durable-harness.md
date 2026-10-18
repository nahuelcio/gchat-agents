# ADR 0001 — Durable agent runtime: Pi Durable in a sidecar

Status: accepted · 2026-10-17

## Context

Switchboard bridges Google Chat and the team chat to coding agents. Today every turn spawns a CLI (`opencode` or `claude`). A turn in flight lives only in memory: a crash or restart loses it, and Google retrying a webhook could produce a second reply.

[Pi Durable](https://earendil.com/posts/pi-durable/) (`@earendil-works/pi-durable`, MIT) is a durable agent runtime: every model request and tool call is a checkpointed task in SQLite, a repeated `requestId` returns the original submission, replay-safe tools rerun after a crash and the rest get an *interrupted* result. It is a TypeScript library for Node 22.19+, with no server and no MCP client of its own.

## Decision

1. **Use Pi Durable, do not reimplement it.** It runs in `harness/server.ts`, a small Node sidecar that embeds the library and owns `DATA_DIR/harness.sqlite`.
2. **Rust stays the bridge.** It starts the sidecar (`node --experimental-strip-types harness/server.ts`), restarts it if it exits, and talks to it over loopback HTTP (`PI_PORT`, default 8090): `POST /turn`, `POST /abort`, `GET /health`.
3. **`pi` is one more driver** next to `opencode` and `claude`, chosen globally or per persona. `session_ref` holds the Pi conversation id.
4. **Exactly-once turns end to end.** The Rust turn ledger's request id is the Pi `requestId`; the sidecar maps each `requestId` to its conversation before submitting. On restart, unfinished turns on Pi are resubmitted with the same id and their answer is posted; on the CLIs they are announced as cut, never relaunched. The Pi driver retries a lost connection with the same id while the sidecar restarts.
5. **Tools.** Pi's `CodingTools` (`read`, `write`, `edit`, `bash`) plus Switchboard tools (`create_xlsx`, `list_spreadsheets`) that call the Rust admin. `create_xlsx` is `replay: "safe"` because Drive files are tagged with the task id. The tool list follows the agent's MCPs: `coding` → coding tools, `google-drive` → Drive tools; an agent without MCPs gets both.
6. **Models** come from pi-ai's catalog (`provider/model`, keys from the provider's env var). `PI_FAUX=1` swaps in a scripted provider for tests.
7. **Tool environment** gets the bridge env without secrets (anything named like a key, token, password or credential).

## Consequences

- Node 22.19+ is required to use the `pi` driver; without it the other drivers keep working.
- One sidecar process owns the SQLite file; Pi has no cross-process locking.
- On Windows a killed sidecar can leave a running `bash` child behind; Pi still never reruns it.
- Pi's API is marked experimental, so the dependency is pinned (`1.3.0`).

## Not doing

- Porting Pi to Rust or forking it.
- Running tools on remote machines.
- Migrating old CLI sessions into Pi.
- Changing the default driver: it stays `opencode`.
