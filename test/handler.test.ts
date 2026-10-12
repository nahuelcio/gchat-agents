import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { AgentDriver, AgentTurnInput, AgentTurnResult } from "../src/driver/types.js";
import { EchoDriver } from "../src/driver/echo.js";
import { handleEvent, type ChatEvent, type HandlerDeps } from "../src/handler.js";
import { TurnQueue } from "../src/queue.js";
import { SessionStore } from "../src/store.js";
import type { PostMessageBody } from "../src/chat-client.js";
import type { TokenVerifier } from "../src/verify.js";

function messageEvent(overrides: Partial<ChatEvent> = {}): ChatEvent {
  return {
    type: "MESSAGE",
    space: { name: "spaces/OK" },
    message: {
      name: "messages/m1",
      argumentText: "hello agent",
      text: "@Agent hello agent",
      thread: { threadKey: "thread-1" },
    },
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

class FakeVerifier implements TokenVerifier {
  private ok: boolean;
  seenAuth?: string;
  constructor(ok: boolean) {
    this.ok = ok;
  }
  async verify(authHeader: string | undefined): Promise<void> {
    this.seenAuth = authHeader;
    if (!this.ok) throw new Error("bad signature");
  }
}

class FakeDriver implements AgentDriver {
  calls: AgentTurnInput[] = [];
  active = 0;
  maxActive = 0;
  reply = "agent reply";
  sessionRef?: string;
  failWith?: Error;
  gate?: { promise: Promise<void>; resolve: (v: void) => void };

  async runTurn(input: AgentTurnInput): Promise<AgentTurnResult> {
    this.calls.push(input);
    this.active += 1;
    this.maxActive = Math.max(this.maxActive, this.active);
    try {
      if (this.gate) await this.gate.promise;
      if (this.failWith) throw this.failWith;
      return { reply: this.reply, sessionRef: this.sessionRef };
    } finally {
      this.active -= 1;
    }
  }
}

class FakeChat {
  posts: { spaceName: string; body: PostMessageBody }[] = [];
  async postMessage(spaceName: string, body: PostMessageBody): Promise<void> {
    this.posts.push({ spaceName, body });
  }
}

function makeDeps(options: { verifierOk?: boolean; driver?: AgentDriver; allowed?: string[] } = {}) {
  const chat = new FakeChat();
  const driver = options.driver ?? new FakeDriver();
  const deps: HandlerDeps = {
    verifier: new FakeVerifier(options.verifierOk ?? true),
    driver,
    chat,
    store: new SessionStore(join(globalDir, "sessions.json")),
    queue: new TurnQueue(),
    config: { allowedSpaces: options.allowed ?? ["spaces/OK"], workdir: "/tmp/agent-wd" },
  };
  return { deps, chat, driver: driver as FakeDriver, store: deps.store };
}

let globalDir: string;
beforeEach(async () => {
  globalDir = await mkdtemp(join(tmpdir(), "gchat-handler-"));
});

describe("handleEvent", () => {
  it("rejects with 401 on a failing verifier and never runs the agent", async () => {
    const { deps, chat, driver } = makeDeps({ verifierOk: false });
    const result = await handleEvent("Bearer bad", messageEvent(), deps);
    expect(result.status).toBe(401);
    expect(result.body).toEqual({ error: "invalid token" });
    expect(driver.calls).toHaveLength(0);
    expect(chat.posts).toHaveLength(0);
    await result.done;
  });

  it("passes the Authorization header to the verifier", async () => {
    const { deps } = makeDeps();
    const verifier = deps.verifier as FakeVerifier;
    await handleEvent("Bearer tok", messageEvent(), deps);
    expect(verifier.seenAuth).toBe("Bearer tok");
  });

  it("drops events from non-allowlisted spaces with 200", async () => {
    const { deps, chat, driver } = makeDeps({ allowed: ["spaces/OTHER"] });
    const result = await handleEvent("Bearer t", messageEvent(), deps);
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ ok: true, dropped: true });
    expect(driver.calls).toHaveLength(0);
    expect(chat.posts).toHaveLength(0);
    await result.done;
  });

  it("runs the full MESSAGE flow with EchoDriver and posts to the same space/thread", async () => {
    const { deps, chat } = makeDeps({ driver: new EchoDriver() });
    const result = await handleEvent(
      "Bearer t",
      messageEvent({
        message: {
          name: "messages/m2",
          argumentText: "say hi",
          thread: { threadKey: "thread-9" },
        },
      }),
      deps,
    );
    expect(result.status).toBe(200);
    await result.done;
    expect(chat.posts).toEqual([
      {
        spaceName: "spaces/OK",
        body: { text: "Echo: say hi", thread: { threadKey: "thread-9" } },
      },
    ]);
  });

  it("prefers argumentText over text", async () => {
    const { deps, driver } = makeDeps();
    const result = await handleEvent("Bearer t", messageEvent(), deps);
    await result.done;
    expect(driver.calls[0]?.text).toBe("hello agent");
  });

  it("strips mentions when only text is present", async () => {
    const { deps, driver } = makeDeps();
    const result = await handleEvent(
      "Bearer t",
      messageEvent({ message: { text: "<@u1> run tests", thread: { threadKey: "t" } } }),
      deps,
    );
    await result.done;
    expect(driver.calls[0]?.text).toBe("run tests");
  });

  it("drops messages with no usable text without running the agent", async () => {
    const { deps, driver } = makeDeps();
    const result = await handleEvent(
      "Bearer t",
      messageEvent({ message: { text: "<@u1>", thread: { threadKey: "t" } } }),
      deps,
    );
    expect(result.body).toEqual({ ok: true, dropped: true });
    expect(driver.calls).toHaveLength(0);
    await result.done;
  });

  it("drops MESSAGE events with no thread identity instead of inventing a session", async () => {
    const { deps, driver, chat } = makeDeps();
    const result = await handleEvent(
      "Bearer t",
      messageEvent({ message: { name: "messages/orphan", argumentText: "hi" } }),
      deps,
    );
    expect(result.body).toEqual({ ok: true, dropped: true });
    expect(driver.calls).toHaveLength(0);
    expect(chat.posts).toHaveLength(0);
    await result.done;
  });

  it("persists the sessionRef and passes it to the next turn of the same thread", async () => {
    const driver = new FakeDriver();
    driver.sessionRef = "ses_123";
    const { deps, store } = makeDeps({ driver });

    const first = await handleEvent("Bearer t", messageEvent(), deps);
    await first.done;
    expect(driver.calls[0]?.sessionRef).toBeUndefined();
    expect(store.get("thread-1")?.sessionRef).toBe("ses_123");

    const second = await handleEvent("Bearer t", messageEvent(), deps);
    await second.done;
    expect(driver.calls[1]?.sessionRef).toBe("ses_123");
  });

  it("uses thread.name as threadKey and reply thread when present", async () => {
    const driver = new FakeDriver();
    driver.sessionRef = "ses_n";
    const { deps, chat } = makeDeps({ driver });
    const result = await handleEvent(
      "Bearer t",
      messageEvent({
        message: { name: "messages/m3", argumentText: "hi", thread: { name: "spaces/OK/threads/x" } },
      }),
      deps,
    );
    await result.done;
    expect(driver.calls[0]?.threadKey).toBe("spaces/OK/threads/x");
    expect(chat.posts[0]?.body.thread).toEqual({ name: "spaces/OK/threads/x" });
  });

  it("posts a readable error to the same thread when the agent fails", async () => {
    const driver = new FakeDriver();
    driver.failWith = new Error("provider auth failed");
    const { deps, chat } = makeDeps({ driver });
    const result = await handleEvent("Bearer t", messageEvent(), deps);
    await result.done;
    expect(chat.posts).toEqual([
      {
        spaceName: "spaces/OK",
        body: { text: "⚠️ Agent failed: provider auth failed", thread: { threadKey: "thread-1" } },
      },
    ]);
  });

  it("splits long replies into chunks of at most 3800 chars", async () => {
    const driver = new FakeDriver();
    driver.reply = `${"a".repeat(3800)}\n${"b".repeat(100)}`;
    const { deps, chat } = makeDeps({ driver });
    const result = await handleEvent("Bearer t", messageEvent(), deps);
    await result.done;
    expect(chat.posts).toHaveLength(2);
    expect(chat.posts[0]?.body.text).toHaveLength(3800);
    expect(chat.posts[1]?.body.text).toBe("\n" + "b".repeat(100));
    expect(chat.posts.every((p) => p.body.thread?.threadKey === "thread-1")).toBe(true);
  });

  it("greets on ADDED_TO_SPACE without running the agent", async () => {
    const { deps, chat, driver } = makeDeps();
    const result = await handleEvent(
      "Bearer t",
      messageEvent({ type: "ADDED_TO_SPACE", message: undefined }),
      deps,
    );
    expect(result.status).toBe(200);
    await result.done;
    expect(chat.posts).toHaveLength(1);
    expect(chat.posts[0]?.body.text).toContain("OpenCode");
    expect(chat.posts[0]?.body.thread).toBeUndefined();
    expect(driver.calls).toHaveLength(0);
  });

  it("ignores unknown event types", async () => {
    const { deps, chat, driver } = makeDeps();
    const result = await handleEvent("Bearer t", messageEvent({ type: "CARD_CLICKED" }), deps);
    expect(result.status).toBe(200);
    expect(driver.calls).toHaveLength(0);
    await result.done;
    expect(chat.posts).toHaveLength(0);
  });

  it("returns 200 immediately and runs the turn in the background, serially per thread", async () => {
    const gate = deferred<void>();
    const driver = new FakeDriver();
    driver.gate = gate;
    const { deps, chat } = makeDeps({ driver });

    const first = await handleEvent("Bearer t", messageEvent(), deps);
    expect(first.status).toBe(200);
    expect(driver.calls).toHaveLength(1); // started, still gated

    const second = await handleEvent("Bearer t", messageEvent(), deps);
    expect(second.status).toBe(200);
    expect(driver.calls).toHaveLength(1); // second turn waiting: not started

    gate.resolve();
    await Promise.all([first.done, second.done]);
    expect(driver.calls).toHaveLength(2);
    expect(driver.maxActive).toBe(1);
    expect(chat.posts).toHaveLength(2);
  });

  it("lets different threads run concurrently", async () => {
    const gate = deferred<void>();
    const driver = new FakeDriver();
    driver.gate = gate;
    const { deps } = makeDeps({ driver });

    const a = await handleEvent(
      "Bearer t",
      messageEvent({ message: { argumentText: "a", thread: { threadKey: "ta" } } }),
      deps,
    );
    const b = await handleEvent(
      "Bearer t",
      messageEvent({ message: { argumentText: "b", thread: { threadKey: "tb" } } }),
      deps,
    );
    expect(driver.calls).toHaveLength(2);
    expect(driver.maxActive).toBe(2);
    gate.resolve();
    await Promise.all([a.done, b.done]);
  });
});
