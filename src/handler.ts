import type { ChatClient, PostMessageBody } from "./chat-client.js";
import type { TurnQueue } from "./queue.js";
import { describeCron, type ScheduleStore } from "./schedules.js";
import type { SessionRecord, SessionStore } from "./store.js";
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

export type ContextFooter = "every" | "every5" | "above60" | "never";

/** Runtime options read on every turn (the control plane can change them). */
export interface TurnOptions {
  contextFooter: ContextFooter;
  /** Compact automatically when context use reaches this percent; 0 = never. */
  autoCompactAt: number;
  /** Default model label for the footer when the thread has no override. */
  defaultModel?: string;
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
  /** Recurring jobs; omitted = /schedule disabled. */
  schedules?: ScheduleStore;
  options?: () => TurnOptions;
}

export interface HandleResult {
  status: number;
  body: Record<string, unknown>;
  /** Resolves when the background work triggered by this event settles. */
  done: Promise<void>;
}

/** One message to process for a thread, from Chat, the playground or a schedule. */
export interface TurnRequest {
  threadKey: string;
  spaceName: string;
  text: string;
  sender?: string;
  reply: (text: string) => Promise<void>;
}

const REPLY_LIMIT = 3800;
const GREETING =
  "Hi! I bridge this space to a local OpenCode agent. " +
  "Send me a message (mention me in spaces) and I will reply in this thread. " +
  "Turns run one at a time per thread and can take a while.";

const HELP = [
  "Bridge commands:",
  "/repo <name> — create this thread's worktree (branch chat/<thread>) and work there",
  "/up — start the repo's app from the worktree",
  "/down — stop the app",
  "/logs — last lines of the app output",
  "/status — repo, branch, worktree, app, context",
  "/close — stop the app and remove the worktree (the branch is kept)",
  "",
  "Session commands:",
  "/context — model, repo and context use now",
  "/compact — summarize the session and continue in a fresh one",
  "/clear — start a fresh session (worktree untouched)",
  "/model <id>|default — model for this thread only",
  "",
  "Schedules:",
  "/schedule <m h dom mon dow> <prompt> — run a prompt on a cron, results in this space",
  "/schedules — list them",
  "/unschedule <id> — delete one",
  "",
  "Anything else goes to the agent.",
].join("\n");

const COMPACT_PROMPT =
  "Summarize this conversation so a fresh session can continue it: goals, decisions made, " +
  "current state of the code and worktree, open tasks and open questions. Be concise; no preamble.";

const DEFAULT_OPTIONS: TurnOptions = { contextFooter: "never", autoCompactAt: 0 };

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

  const done = processMessage(
    {
      threadKey,
      spaceName,
      text,
      sender: event.message.sender?.displayName ?? event.user?.displayName,
      reply: (msg) => postReply(deps.chat, spaceName, thread, msg),
    },
    deps,
  ).then(() => undefined);

  return { status: 200, body: { ok: true }, done };
}

/**
 * Queues one message on its thread and handles it: a /command or an agent turn.
 * Resolves `ok: false` when the agent failed (the error was already replied).
 */
export function processMessage(req: TurnRequest, deps: HandlerDeps): Promise<{ ok: boolean }> {
  return deps.queue.run(req.threadKey, async () => {
    if (req.text.startsWith("/")) {
      try {
        await req.reply(await runCommand(req, deps));
        return { ok: true };
      } catch (err) {
        console.error(`[command ${req.threadKey}] failed:`, err);
        await req.reply(`Command failed: ${errorMessage(err)}`);
        return { ok: false };
      }
    }
    return agentTurn(req, deps);
  });
}

async function agentTurn(req: TurnRequest, deps: HandlerDeps): Promise<{ ok: boolean }> {
  const { threadKey, spaceName } = req;
  const record = deps.store.get(threadKey);
  // Shared threads: the agent must know which teammate is talking.
  let text = req.sender ? `${req.sender}: ${req.text}` : req.text;
  if (record?.summary && !record.sessionRef) {
    text = `Context from earlier in this thread (compacted):\n${record.summary}\n\n---\n\n${text}`;
  }
  let result;
  try {
    result = await deps.driver.runTurn({
      threadKey,
      sessionRef: record?.sessionRef,
      text,
      workdir: record?.worktree ?? deps.config.workdir,
      model: record?.model,
    });
  } catch (err) {
    console.error(`[turn ${threadKey}] failed:`, err);
    await req.reply(`Agent failed: ${errorMessage(err)}`);
    return { ok: false };
  }

  // claude reports real usage; otherwise estimate from text that went through (~4 chars/token).
  const usage = result.usage
    ? { contextTokens: result.usage.contextTokens, contextWindow: result.usage.contextWindow, estimated: false }
    : {
        contextTokens: (record?.estimated !== false ? (record?.contextTokens ?? 0) : 0) + Math.ceil((text.length + result.reply.length) / 4),
        contextWindow: undefined,
        estimated: true,
      };
  const turns = (record?.turns ?? 0) + 1;
  const updated = await deps.store
    .update(threadKey, spaceName, {
      ...(result.sessionRef && { sessionRef: result.sessionRef }),
      summary: undefined,
      ...usage,
      turns,
    })
    .then(() => deps.store.get(threadKey))
    .catch((err: unknown) => {
      console.error(`[store ${threadKey}] persist failed:`, errorMessage(err));
      return undefined;
    });

  const options = deps.options?.() ?? DEFAULT_OPTIONS;
  const footer = updated && shouldShowFooter(options.contextFooter, updated) ? `\n\n${contextLine(updated, options)}` : "";
  await req.reply(result.reply + footer);

  const pct = updated ? contextPercent(updated) : undefined;
  if (options.autoCompactAt > 0 && pct !== undefined && pct >= options.autoCompactAt) {
    await req.reply(`Context at ${pct}% — compacting automatically.\n${await compact(threadKey, spaceName, deps)}`);
  }
  return { ok: true };
}

function contextPercent(r: SessionRecord): number | undefined {
  return r.contextWindow && r.contextTokens !== undefined ? Math.round((r.contextTokens / r.contextWindow) * 100) : undefined;
}

function shouldShowFooter(mode: ContextFooter, r: SessionRecord): boolean {
  if (mode === "every") return true;
  if (mode === "every5") return (r.turns ?? 0) % 5 === 0;
  if (mode === "above60") return (contextPercent(r) ?? 0) >= 60;
  return false;
}

/** Local "Mon 19 Oct 09:00" — what a person in the thread expects to read. */
function formatWhen(iso?: string): string {
  return iso ? new Date(iso).toLocaleString("en-GB", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "—";
}

function formatTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(n >= 100_000 ? 0 : 1)}k` : String(n);
}

/** "glm-5.3-flash · yFlow@chat/abc · context 62% (79k/128k)" — `~` marks an estimate. */
export function contextLine(r: SessionRecord, options: TurnOptions): string {
  const model = r.model ?? options.defaultModel ?? "default model";
  const where = r.repo ? `${r.repo}@${r.branch}` : "chat only";
  const pct = contextPercent(r);
  const tokens = r.contextTokens ?? 0;
  const ctx =
    pct !== undefined
      ? `context ${pct}% (${formatTokens(tokens)}/${formatTokens(r.contextWindow!)})`
      : r.estimated
        ? `~${formatTokens(tokens)} tokens exchanged` // opencode: chat text only, not its system prompt
        : `context ${formatTokens(tokens)} tokens`;
  return `— ${model} · ${where} · ${ctx}`;
}

/** Asks the agent for a summary, then starts a fresh session seeded with it on the next turn. */
async function compact(threadKey: string, spaceName: string, deps: HandlerDeps): Promise<string> {
  const record = deps.store.get(threadKey);
  if (!record?.sessionRef) return "Nothing to compact yet.";
  const before = record.contextTokens;
  const result = await deps.driver.runTurn({
    threadKey,
    sessionRef: record.sessionRef,
    text: COMPACT_PROMPT,
    workdir: record.worktree ?? deps.config.workdir,
    model: record.model,
  });
  const after = Math.ceil(result.reply.length / 4);
  await deps.store.update(threadKey, spaceName, {
    sessionRef: undefined,
    summary: result.reply,
    contextTokens: after,
    estimated: true,
  });
  return `Session compacted${before ? `: ~${formatTokens(before)} → ~${formatTokens(after)} tokens` : ""}. The next message continues from the summary.`;
}

/** Runs a /command for a thread and returns the text to post. Runs inside the thread's queue slot. */
async function runCommand(req: TurnRequest, deps: HandlerDeps): Promise<string> {
  const { threadKey, spaceName } = req;
  const [command = "", arg, ...rest] = req.text.slice(1).split(/\s+/);
  const record = deps.store.get(threadKey);
  const options = deps.options?.() ?? DEFAULT_OPTIONS;

  switch (command) {
    case "help":
      return HELP;
    case "context":
      return record ? contextLine(record, options).slice(2) : "No session in this thread yet.";
    case "clear":
      await deps.store.update(threadKey, spaceName, { sessionRef: undefined, summary: undefined, contextTokens: 0, turns: 0 });
      return "Started a fresh session for this thread. The worktree and branch are untouched.";
    case "compact":
      return compact(threadKey, spaceName, deps);
    case "model": {
      if (!arg) return `This thread uses ${record?.model ?? options.defaultModel ?? "the default model"}. /model <id> or /model default.`;
      const model = arg === "default" ? undefined : arg;
      await deps.store.update(threadKey, spaceName, { model });
      return model ? `This thread now uses ${model}. Other threads keep the default.` : "This thread is back on the default model.";
    }
    case "schedule":
    case "schedules":
    case "unschedule":
      return scheduleCommand(command, [arg, ...rest].filter((x): x is string => Boolean(x)), req, deps);
  }

  const ws = deps.workspaces;
  if (!ws) return "Thread commands are not enabled on this bridge (no repos configured).";
  const slug = threadSlug(threadKey);

  switch (command) {
    case "repo": {
      if (!arg) return `Usage: /repo <name>. Configured: ${ws.repoNames().join(", ")}`;
      if (record?.worktree) return `This thread already works in ${record.repo} (${record.worktree}). /close it first.`;
      const { worktree, branch } = await ws.create(arg, slug);
      await deps.store.update(threadKey, spaceName, { repo: arg, worktree, branch });
      return `Worktree ready: ${worktree}\nBranch: ${branch}\nThe agent now works there for this thread.`;
    }
    case "status": {
      const ctx = record ? contextLine(record, options).slice(2) : "no session yet";
      if (!record?.worktree) return `No worktree for this thread. Use /repo <name>.\n${ctx}`;
      return [
        `Repo: ${record.repo}`,
        `Branch: ${record.branch}`,
        `Worktree: ${record.worktree}`,
        `App: ${ws.isUp(slug) ? `running on :${ws.port(slug)}` : "stopped"}`,
        ctx,
      ].join("\n");
    }
  }

  if (!record?.worktree || !record.repo) return "No worktree for this thread yet. Use /repo <name> first.";
  switch (command) {
    case "up": {
      const { port } = await ws.up(slug, record.repo, record.worktree);
      return `App starting on http://localhost:${port} — /logs to follow it.`;
    }
    case "down":
      return ws.down(slug) ? "App stopped." : "The app is not running.";
    case "logs":
      return ws.logs(slug) || "(no output yet)";
    case "close": {
      ws.down(slug);
      await ws.remove(record.repo, record.worktree);
      await deps.store.update(threadKey, spaceName, { worktree: undefined, repo: undefined });
      return `Worktree removed. Branch ${record.branch} is kept in the repo.`;
    }
    default:
      return `Unknown command /${command}.\n\n${HELP}`;
  }
}

async function scheduleCommand(command: string, args: string[], req: TurnRequest, deps: HandlerDeps): Promise<string> {
  const schedules = deps.schedules;
  if (!schedules) return "Schedules are not enabled on this bridge.";
  if (command === "schedules") {
    const jobs = schedules.all();
    if (jobs.length === 0) return "No schedules. Create one with /schedule <m h dom mon dow> <prompt>.";
    return jobs
      .map((j) => `${j.id} · ${j.name} · ${describeCron(j.cron)} · ${j.enabled ? `next ${formatWhen(j.nextRunAt)}` : "paused"}`)
      .join("\n");
  }
  if (command === "unschedule") {
    const id = args[0];
    if (!id || !schedules.get(id)) return "Usage: /unschedule <id> (see /schedules).";
    await schedules.remove(id);
    return `Schedule ${id} deleted.`;
  }
  // /schedule <5 cron fields> <prompt...>
  if (args.length < 6) return "Usage: /schedule <m h dom mon dow> <prompt>, e.g. /schedule 0 9 * * 1-5 Summarize yesterday's commits";
  const cron = args.slice(0, 5).join(" ");
  const prompt = args.slice(5).join(" ");
  const record = deps.store.get(req.threadKey);
  const job = await schedules.add({
    name: prompt.length > 48 ? `${prompt.slice(0, 47)}…` : prompt,
    prompt,
    cron,
    space: req.spaceName,
    createdBy: req.sender ?? "someone in a thread",
    ...(record?.repo && { repo: record.repo }),
  });
  return `Scheduled ${job.id}: ${describeCron(cron)}. Next run ${formatWhen(job.nextRunAt)}. Results post in this space.`;
}
