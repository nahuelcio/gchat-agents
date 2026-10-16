/**
 * End-to-end smoke run without Google: fabricates a MESSAGE event and runs the
 * real handler with a print-to-console ChatClient and an accept-all verifier.
 *
 *   npm run smoke -- --driver echo                (default when --driver omitted)
 *   npm run smoke -- --driver opencode            (real CLI; uses env config)
 *   npm run smoke -- --driver claude              (real CLI; uses env config)
 *   npm run smoke -- --text "list files here"
 *   AGENT_REPOS_FILE=repos.json npm run smoke -- --driver echo --text "/repo app" --text "/up" --text "/logs"
 *     (each --text is one message in the same thread, sent in order)
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { EchoDriver } from "../src/driver/echo.js";
import { ClaudeDriver } from "../src/driver/claude.js";
import { OpenCodeDriver } from "../src/driver/opencode.js";
import type { AgentDriver } from "../src/driver/types.js";
import { handleEvent, type ChatEvent, type HandlerDeps } from "../src/handler.js";
import { TurnQueue } from "../src/queue.js";
import { SessionStore } from "../src/store.js";
import type { ChatClient } from "../src/chat-client.js";
import type { TokenVerifier } from "../src/verify.js";
import { loadRepos } from "../src/config.js";
import { Workspaces } from "../src/workspace.js";

const argv = process.argv.slice(2);
function argValue(name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

const driverName = argValue("--driver") ?? "opencode";
const texts = argv.flatMap((a, i) => (a === "--text" && argv[i + 1] ? [argv[i + 1]!] : []));
if (texts.length === 0) texts.push("Introduce yourself in one sentence.");

const env = process.env;
const dataDir = env["DATA_DIR"]?.trim() || "./data";
const workdir = env["AGENT_WORKDIR"]?.trim() || process.cwd();
mkdirSync(dataDir, { recursive: true });

const driver: AgentDriver =
  driverName === "echo"
    ? new EchoDriver()
    : driverName === "claude"
      ? new ClaudeDriver({
          bin: env["CLAUDE_BIN"]?.trim() || "claude",
          model: env["CLAUDE_MODEL"]?.trim() || undefined,
          timeoutMs: Number(env["AGENT_TURN_TIMEOUT_MS"] ?? "") || 600_000,
        })
      : new OpenCodeDriver({
          bin: env["OPENCODE_BIN"]?.trim() || "opencode",
          model: env["OPENCODE_MODEL"]?.trim() || undefined,
          timeoutMs: Number(env["AGENT_TURN_TIMEOUT_MS"] ?? "") || 600_000,
        });

/** Prints instead of POSTing — nothing leaves the machine. */
const printingChat: ChatClient = {
  async postMessage(spaceName, body) {
    console.log(`\n>>> POST ${spaceName} thread=${JSON.stringify(body.thread ?? null)}`);
    console.log(body.text);
  },
};

/** Smoke runs locally: no Google signature to check. */
const acceptAll: TokenVerifier = {
  async verify() {},
};

const deps: HandlerDeps = {
  verifier: acceptAll,
  driver,
  chat: printingChat,
  store: new SessionStore(join(dataDir, "sessions.json")),
  queue: new TurnQueue(),
  config: { allowedSpaces: ["spaces/SMOKE"], workdir },
};
const repos = loadRepos(env["AGENT_REPOS_FILE"]?.trim() || undefined);
if (Object.keys(repos).length) deps.workspaces = new Workspaces(join(dataDir, "worktrees"), repos);

console.log(`smoke: driver=${driverName} workdir=${workdir}`);
for (const [n, text] of texts.entries()) {
  const event: ChatEvent = {
    type: "MESSAGE",
    space: { name: "spaces/SMOKE" },
    message: {
      name: `messages/smoke-${n + 1}`,
      argumentText: text,
      thread: { name: "spaces/SMOKE/threads/smoke" },
      sender: { displayName: "Smoke User" },
    },
  };
  console.log(`\nuser > ${text}`);
  const result = await handleEvent("Bearer smoke-token", event, deps);
  console.log(`http > ${result.status} ${JSON.stringify(result.body)}`);
  await result.done;
  // Give a just-started app a moment to print before a following /logs.
  if (text.startsWith("/up")) await new Promise((r) => setTimeout(r, 1500));
}
deps.workspaces?.killAll();
console.log("\nsmoke: done");
