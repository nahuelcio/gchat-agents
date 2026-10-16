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

let close: (() => Promise<void>) | undefined;
afterEach(async () => close?.());

describe("ShareToken", () => {
  it("creates a long random token once (mode 600), keeps it across restarts, and rotates", async () => {
    const file = join(await mkdtemp(join(tmpdir(), "gchat-share-")), "share-token");
    const a = new ShareToken(file);
    expect(a.value()).toMatch(/^[a-f0-9]{48}$/);
    expect(statSync(file).mode & 0o777).toBe(0o600);
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
    expect((await send({ thread: "guest-a1b2", text: "hi", name: "Ana" }, "Bearer wrong")).status).toBe(401);
  });

  it("runs a turn as the named guest in their own thread", async () => {
    const { send, deps } = await start();
    const res = (await (await send({ thread: "guest-a1b2", text: "hi", name: "Ana" })).json()) as { replies: string[] };
    expect(res.replies).toEqual(["Echo: Ana: hi"]);
    expect(deps.store.get("share/guest-a1b2")).toBeDefined();
  });

  it("blocks machine-touching commands for guests but allows session ones", async () => {
    const { send } = await start();
    const repo = (await (await send({ thread: "guest-a1b2", text: "/repo yFlow", name: "Ana" })).json()) as { replies: string[] };
    expect(repo.replies[0]).toContain("not available");
    const agent = (await (await send({ thread: "guest-a1b2", text: "/agent claude", name: "Ana" })).json()) as { replies: string[] };
    expect(agent.replies[0]).toContain("Claude Code");
  });

  it("does not expose the control plane API on the public port", async () => {
    const { base } = await start();
    expect((await fetch(`${base}/api/settings`)).status).toBe(404);
  });
});
