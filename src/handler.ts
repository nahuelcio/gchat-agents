import type { ChatClient, PostMessageBody } from "./chat-client.js";
import type { TurnQueue } from "./queue.js";
import type { SessionStore } from "./store.js";
import { chunkText, extractPrompt } from "./text.js";
import type { AgentDriver } from "./driver/types.js";
import type { TokenVerifier } from "./verify.js";
import { threadSlug, type Workspaces } from "./workspace.js";

/** Google Chat app event, reduced to the fields this service reads. */
export interface ChatEvent {
  type?: string;
  space?: { name?: string };
  message?: {
    name?: string;
    argumentText?: string;
    text?: string;
    thread?: { name?: string; threadKey?: string };
    sender?: { displayName?: string };
  };
  user?: { displayName?: string };
}

export interface HandlerConfig {
  allowedSpaces: string[];
  workdir: string;
}

export interface HandlerDeps {
  verifier: TokenVerifier;
  driver: AgentDriver;
  chat: ChatClient;
  store: SessionStore;
  queue: TurnQueue;
  config: HandlerConfig;
  /** Per-thread worktrees and dev servers; omitted = commands disabled. */
  workspaces?: Workspaces;
}

export interface HandleResult {
  status: number;
  body: Record<string, unknown>;
  /** Resolves when the background work triggered by this event settles. */
  done: Promise<void>;
}

const REPLY_LIMIT = 3800;
const GREETING =
  "Hi! I bridge this space to a local OpenCode agent. " +
  "Send me a message (mention me in spaces) and I will reply in this thread. " +
  "Turns run one at a time per thread and can take a while.";

const HELP = [
  "Thread commands:",
  "/repo <name> — create this thread's worktree (branch chat/<thread>) and work there",
  "/up — start the repo's app from the worktree",
  "/down — stop the app",
  "/logs — last lines of the app output",
  "/status — repo, branch, worktree, app",
  "/close — stop the app and remove the worktree (the branch is kept)",
  "Anything else goes to the agent.",
].join("\n");

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function postReply(
  chat: ChatClient,
  spaceName: string,
  thread: PostMessageBody["thread"],
  text: string,
): Promise<void> {
  for (const chunk of chunkText(text, REPLY_LIMIT)) {
    await chat.postMessage(spaceName, { text: chunk, thread });
  }
}

/**
 * Handles one Chat event. Returns 200 fast; the agent turn and the reply posts
 * happen in the background (Google Chat requires a quick response and retries
 * non-2xx). `done` lets tests and the smoke script await that background work.
 */
export async function handleEvent(
  authHeader: string | undefined,
  event: ChatEvent,
  deps: HandlerDeps,
): Promise<HandleResult> {
  const settled: Promise<void> = Promise.resolve();
  try {
    await deps.verifier.verify(authHeader);
  } catch (err) {
    console.error("[auth] rejected event:", errorMessage(err));
    return { status: 401, body: { error: "invalid token" }, done: settled };
  }

  const spaceName = event.space?.name;
  if (!spaceName || !deps.config.allowedSpaces.includes(spaceName)) {
    console.info(`[allowlist] dropped event from ${spaceName ?? "<no space>"}`);
    return { status: 200, body: { ok: true, dropped: true }, done: settled };
  }

  if (event.type === "ADDED_TO_SPACE") {
    const done = postReply(deps.chat, spaceName, undefined, GREETING).catch((err: unknown) => {
      console.error("[greeting] failed:", errorMessage(err));
    });
    return { status: 200, body: { ok: true }, done };
  }

  if (event.type !== "MESSAGE" || !event.message) {
    return { status: 200, body: { ok: true }, done: settled };
  }

  const text = extractPrompt(event.message);
  // Only real thread identities: falling back to message.name would give every
  // malformed event a fresh session and an unthreaded reply.
  const threadKey = event.message.thread?.name ?? event.message.thread?.threadKey;
  if (!text || !threadKey) {
    console.info("[message] dropped: no usable text or thread key");
    return { status: 200, body: { ok: true, dropped: true }, done: settled };
  }
  const thread = event.message.thread?.name
    ? { name: event.message.thread.name }
    : event.message.thread?.threadKey
      ? { threadKey: event.message.thread.threadKey }
      : undefined;

  const sender = event.message.sender?.displayName ?? event.user?.displayName;
  const reply = (msg: string) => postReply(deps.chat, spaceName, thread, msg);

  const done = deps.queue.run(threadKey, async () => {
    if (text.startsWith("/")) {
      try {
        await reply(await runCommand(text, threadKey, spaceName, deps));
      } catch (err) {
        console.error(`[command ${threadKey}] failed:`, err);
        await reply(`⚠️ ${errorMessage(err)}`);
      }
      return;
    }
    const record = deps.store.get(threadKey);
    let result;
    try {
      result = await deps.driver.runTurn({
        threadKey,
        sessionRef: record?.sessionRef,
        // Shared threads: the agent must know which teammate is talking.
        text: sender ? `${sender}: ${text}` : text,
        workdir: record?.worktree ?? deps.config.workdir,
      });
    } catch (err) {
      console.error(`[turn ${threadKey}] failed:`, err);
      await reply(`⚠️ Agent failed: ${errorMessage(err)}`);
      return;
    }
    if (result.sessionRef) {
      await deps.store
        .update(threadKey, spaceName, { sessionRef: result.sessionRef })
        .catch((err: unknown) => console.error(`[store ${threadKey}] persist failed:`, errorMessage(err)));
    }
    await reply(result.reply);
  });

  return { status: 200, body: { ok: true }, done };
}

/** Runs a /command for a thread and returns the text to post. Runs inside the thread's queue slot. */
async function runCommand(text: string, threadKey: string, spaceName: string, deps: HandlerDeps): Promise<string> {
  const [command = "", arg] = text.slice(1).split(/\s+/);
  const ws = deps.workspaces;
  if (command === "help" || !ws) return ws ? HELP : "Thread commands are not enabled on this bridge (no repos configured).";
  const record = deps.store.get(threadKey);
  const slug = threadSlug(threadKey);

  switch (command) {
    case "repo": {
      if (!arg) return `Usage: /repo <name>. Configured: ${ws.repoNames().join(", ")}`;
      if (record?.worktree) return `This thread already works in ${record.repo} (${record.worktree}). /close it first.`;
      const { worktree, branch } = await ws.create(arg, slug);
      await deps.store.update(threadKey, spaceName, { repo: arg, worktree, branch });
      return `🌱 Worktree ready: ${worktree}\nBranch: ${branch}\nThe agent now works there for this thread.`;
    }
    case "status": {
      if (!record?.worktree) return "No worktree for this thread. Use /repo <name>.";
      return [
        `Repo: ${record.repo}`,
        `Branch: ${record.branch}`,
        `Worktree: ${record.worktree}`,
        `App: ${ws.isUp(slug) ? "running" : "stopped"}`,
      ].join("\n");
    }
  }

  if (!record?.worktree || !record.repo) return "No worktree for this thread yet. Use /repo <name> first.";
  switch (command) {
    case "up": {
      const { port } = await ws.up(slug, record.repo, record.worktree);
      return `🚀 App starting on http://localhost:${port} — /logs to follow it.`;
    }
    case "down":
      return ws.down(slug) ? "🛑 App stopped." : "The app is not running.";
    case "logs":
      return ws.logs(slug) || "(no output yet)";
    case "close": {
      ws.down(slug);
      await ws.remove(record.repo, record.worktree);
      await deps.store.update(threadKey, spaceName, { worktree: undefined, repo: undefined });
      return `🧹 Worktree removed. Branch ${record.branch} is kept in the repo.`;
    }
    default:
      return `Unknown command /${command}.\n\n${HELP}`;
  }
}
