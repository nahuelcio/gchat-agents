import { statSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EchoDriver } from "../src/driver/echo.js";
import type { HandlerDeps } from "../src/handler.js";
import { TurnQueue } from "../src/queue.js";
import { createHttpServer } from "../src/server.js";
import { ShareToken } from "../src/share.js";
import { SessionStore } from "../src/store.js";
import { TranscriptStore } from "../src/transcripts.js";

let close: (() => Promise<void>) | undefined;
afterEach(async () => close?.());

async function waitFor<T>(load: () => Promise<T>, ok: (v: T) => boolean, ms = 2000): Promise<T> {
  const deadline = Date.now() + ms;
  let last: T | undefined;
  while (Date.now() < deadline) {
    last = await load();
    if (ok(last)) return last;
    await new Promise((r) => setTimeout(r, 15));
  }
  throw new Error(`timeout waiting: ${JSON.stringify(last)}`);
}

describe("ShareToken", () => {
  it("creates a long random token once (mode 600), keeps it across restarts, and rotates", async () => {
    const file = join(await mkdtemp(join(tmpdir(), "gchat-share-")), "share-token");
    const a = new ShareToken(file);
    expect(a.value()).toMatch(/^[a-f0-9]{48}$/);
    if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(new ShareToken(file).value()).toBe(a.value());
    const old = a.value();
    a.rotate();
    expect(a.value()).not.toBe(old);
    expect(a.check(old)).toBe(false);
    expect(a.check(a.value())).toBe(true);
    expect(a.check(undefined)).toBe(false);
  });
});

describe("shared playground on the public port", () => {
  async function start() {
    const dir = await mkdtemp(join(tmpdir(), "gchat-play-"));
    await mkdir(join(dir, "web"));
    await writeFile(join(dir, "web", "index.html"), "<!doctype html><title>Control plane</title>");
    const token = new ShareToken(join(dir, "share-token"));
    const deps: HandlerDeps = {
      verifier: { verify: async () => {} },
      driver: new EchoDriver(),
      chat: { postMessage: async () => {} },
      store: new SessionStore(join(dir, "sessions.json")),
      queue: new TurnQueue(),
      config: { allowedSpaces: [], workdir: dir },
    };
    const server = createHttpServer(deps, {
      token,
      webDir: join(dir, "web"),
      agents: async () => [{ id: "opencode", name: "OpenCode", installed: true, supported: true, ready: true }],
      personas: () => [{ name: "designer" }, { name: "code" }],
      transcripts: new TranscriptStore(join(dir, "transcripts")),
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    close = () => new Promise((r) => server.close(() => r()));
    const send = (body: unknown, auth = `Bearer ${token.value()}`) =>
      fetch(`${base}/play/api/send`, { method: "POST", headers: { "content-type": "application/json", authorization: auth }, body: JSON.stringify(body) });
    return { base, token, send, deps };
  }

  it("serves the page without a token but every API call needs it", async () => {
    const { base, send } = await start();
    expect((await fetch(`${base}/play`)).status).toBe(200);
    expect((await fetch(`${base}/play/api/agents`)).status).toBe(401);
    expect((await fetch(`${base}/play/api/personas`)).status).toBe(401);
    expect((await send({ thread: "guest-a1b2", text: "hi", name: "Ana" }, "Bearer wrong")).status).toBe(401);
  });

  it("lists @mention personas for guests with a valid token", async () => {
    const { base, token } = await start();
    const res = await fetch(`${base}/play/api/personas`, { headers: { authorization: `Bearer ${token.value()}` } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([{ name: "designer" }, { name: "code" }]);
  });

  it("runs a turn as the named guest in their own thread", async () => {
    const { base, token, send, deps } = await start();
    const res = (await (await send({ thread: "guest-a1b2", text: "hi", name: "Ana" })).json()) as { ok: boolean; replies: string[] };
    expect(res).toMatchObject({ ok: true, replies: [] });
    const thread = await waitFor(
      () =>
        fetch(`${base}/play/api/thread?thread=guest-a1b2`, { headers: { authorization: `Bearer ${token.value()}` } }).then(
          (r) => r.json() as Promise<{ messages: { text: string; bot: boolean }[]; busy: boolean }>,
        ),
      (t) => !t.busy && t.messages.some((m) => m.bot && m.text === "Echo: Ana: hi"),
    );
    expect(thread.messages.map((m) => m.text)).toContain("Echo: Ana: hi");
    expect(deps.store.get("share/guest-a1b2")).toBeDefined();
  });

  it("blocks machine-touching commands for guests but allows session ones", async () => {
    const { base, token, send } = await start();
    expect((await (await send({ thread: "guest-a1b2", text: "/repo yFlow", name: "Ana" })).json())).toMatchObject({ ok: true });
    const afterRepo = await waitFor(
      () =>
        fetch(`${base}/play/api/thread?thread=guest-a1b2`, { headers: { authorization: `Bearer ${token.value()}` } }).then(
          (r) => r.json() as Promise<{ messages: { text: string; bot: boolean }[]; busy: boolean }>,
        ),
      (t) => !t.busy && t.messages.some((m) => m.bot && m.text.includes("not available")),
    );
    expect(afterRepo.messages.find((m) => m.bot)?.text).toContain("not available");
    expect((await (await send({ thread: "guest-a1b2", text: "/agent claude", name: "Ana" })).json())).toMatchObject({ ok: true });
    const afterAgent = await waitFor(
      () =>
        fetch(`${base}/play/api/thread?thread=guest-a1b2`, { headers: { authorization: `Bearer ${token.value()}` } }).then(
          (r) => r.json() as Promise<{ messages: { text: string; bot: boolean }[]; busy: boolean }>,
        ),
      (t) => !t.busy && t.messages.some((m) => m.bot && m.text.includes("Claude Code")),
    );
    expect(afterAgent.messages.some((m) => m.bot && m.text.includes("Claude Code"))).toBe(true);
  });

  it("does not expose the control plane API on the public port", async () => {
    const { base } = await start();
    expect((await fetch(`${base}/api/settings`)).status).toBe(404);
  });

  it("keeps the thread's history so a deeplink shows the whole conversation", async () => {
    const { base, token, send } = await start();
    await send({ thread: "guest-a1b2", text: "hi", name: "Ana" });
    await send({ thread: "guest-a1b2", text: "and me", name: "Luis" });
    const res = await waitFor(
      () =>
        fetch(`${base}/play/api/thread?thread=guest-a1b2`, { headers: { authorization: `Bearer ${token.value()}` } }).then(
          (r) => r.json() as Promise<{ messages: { author: string; text: string }[]; busy: boolean }>,
        ),
      (t) => !t.busy && t.messages.length >= 4,
    );
    // Both human messages land first; replies follow as each queued turn finishes.
    expect(res.messages.map((m) => `${m.author}: ${m.text}`)).toEqual([
      "Ana: hi",
      "Luis: and me",
      "Switchi: Echo: Ana: hi",
      "Switchi: Echo: Luis: and me",
    ]);
    expect(res.busy).toBe(false);
  });

  it("accepts another message while a turn is still queued", async () => {
    const { base, token, send } = await start();
    const first = await send({ thread: "guest-a1b2", text: "hi", name: "Ana" });
    const second = await send({ thread: "guest-a1b2", text: "again", name: "Ana" });
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    const res = await waitFor(
      () =>
        fetch(`${base}/play/api/thread?thread=guest-a1b2`, { headers: { authorization: `Bearer ${token.value()}` } }).then(
          (r) => r.json() as Promise<{ messages: { text: string }[]; busy: boolean }>,
        ),
      (t) => !t.busy && t.messages.length >= 4,
    );
    expect(res.messages.map((m) => m.text)).toEqual(["hi", "again", "Echo: Ana: hi", "Echo: Ana: again"]);
  });
});
