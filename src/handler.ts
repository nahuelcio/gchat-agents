import type { ChatClient, PostMessageBody } from "./chat-client.js";
import type { TurnQueue } from "./queue.js";
import type { SessionStore } from "./store.js";
import { chunkText, extractPrompt } from "./text.js";
import type { AgentDriver } from "./driver/types.js";
import type { TokenVerifier } from "./verify.js";

/** Google Chat app event, reduced to the fields this service reads. */
export interface ChatEvent {
  type?: string;
  space?: { name?: string };
  message?: {
    name?: string;
    argumentText?: string;
    text?: string;
    thread?: { name?: string; threadKey?: string };
  };
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

  const done = deps.queue.run(threadKey, async () => {
    let result;
    try {
      result = await deps.driver.runTurn({
        threadKey,
        sessionRef: deps.store.get(threadKey)?.sessionRef,
        text,
        workdir: deps.config.workdir,
      });
    } catch (err) {
      console.error(`[turn ${threadKey}] failed:`, err);
      await postReply(deps.chat, spaceName, thread, `⚠️ Agent failed: ${errorMessage(err)}`);
      return;
    }
    if (result.sessionRef) {
      await deps.store
        .set(threadKey, {
          sessionRef: result.sessionRef,
          space: spaceName,
          updatedAt: new Date().toISOString(),
        })
        .catch((err: unknown) => console.error(`[store ${threadKey}] persist failed:`, errorMessage(err)));
    }
    await postReply(deps.chat, spaceName, thread, result.reply);
  });

  return { status: 200, body: { ok: true }, done };
}
