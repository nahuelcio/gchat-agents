import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAdminServer, type AdminContext } from "../src/admin.js";
import type { FetchFn } from "../src/integrations.js";
import { SettingsStore } from "../src/settings.js";
import { SessionStore } from "../src/store.js";
import { Workspaces } from "../src/workspace.js";

let store: SettingsStore;
let base: string;
let close: () => Promise<void>;
let dir: string;
let ctx: AdminContext;
let fakeRoutes: Record<string, unknown>;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "gchat-admin-"));
  await mkdir(join(dir, "web"));
  await writeFile(join(dir, "web", "index.html"), "<!doctype html><title>Control plane</title>");
  fakeRoutes = {};
  const fakeFetch: FetchFn = async (url) =>
    fakeRoutes[url] === undefined ? new Response("nope", { status: 404 }) : Response.json(fakeRoutes[url]);
  ctx = {
    store: new SessionStore(join(dir, "sessions.json")),
    workspaces: new Workspaces(join(dir, "wt"), {}),
    reposDir: join(dir, "repos"),
    webDir: join(dir, "web"),
    fetch: fakeFetch,
  };
  store = new SettingsStore(join(dir, "config.json"), {
    agentDriver: "opencode",
    models: {},
    repos: {},
    allowedSpaces: ["spaces/AAA"],
  });
  const server = createAdminServer(store, ctx);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  close = () => new Promise((r) => server.close(() => r()));
});
afterEach(() => close());

describe("admin server", () => {
  it("serves the UI page", async () => {
    const res = await fetch(base);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("<title>");
  });

  it("applies a valid update", async () => {
    const res = await fetch(`${base}/api/settings`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agentDriver: "claude", models: { claude: "claude-opus-5-5" } }),
    });
    expect(res.status).toBe(200);
    expect(store.get().agentDriver).toBe("claude");
  });

  it("returns 400 with the validation message on bad input", async () => {
    const res = await fetch(`${base}/api/settings`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ allowedSpaces: ["nope"] }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/spaces\//);
  });

  it("rejects writes without a JSON content type (blocks simple cross-site form posts)", async () => {
    const res = await fetch(`${base}/api/settings`, { method: "PUT", body: "{}" });
    expect(res.status).toBe(415);
  });

  it("rejects foreign Host headers (DNS rebinding)", async () => {
    const { request } = await import("node:http");
    const status = await new Promise<number>((resolve, reject) => {
      const req = request(`${base}/api/settings`, { headers: { host: "evil.example.com" } }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on("error", reject);
      req.end();
    });
    expect(status).toBe(403);
  });

  it("serves the SPA for client-side routes and blocks path traversal", async () => {
    expect(await (await fetch(`${base}/threads`)).text()).toContain("Control plane");
    const res = await fetch(`${base}/assets/..%2F..%2Fsessions.json`);
    expect(res.status).toBe(404);
  });

  it("lists threads with their worktree and app state, newest first", async () => {
    await ctx.store!.update("spaces/A/threads/old", "spaces/A", { repo: "web", branch: "chat/old" });
    await new Promise((r) => setTimeout(r, 5));
    await ctx.store!.update("spaces/A/threads/new", "spaces/A", { sessionRef: "ses_1" });
    const threads = (await (await fetch(`${base}/api/threads`)).json()) as { slug: string; hasSession: boolean; app: { running: boolean } }[];
    expect(threads.map((t) => t.slug)).toEqual(["new", "old"]);
    expect(threads[0]?.hasSession).toBe(true);
    expect(threads[1]?.app.running).toBe(false);
  });

  it("reports ADO as not connected and refuses ADO calls when the ado CLI is not set up", async () => {
    expect(await (await fetch(`${base}/api/ado/status`)).json()).toEqual({ connected: false });
    expect((await fetch(`${base}/api/ado/projects`)).status).toBe(409);
  });

  it("clones an Azure DevOps repo and registers it, using only the URL ADO returned", async () => {
    const origin = join(dir, "origin");
    execFileSync("git", ["init", "-q", "-b", "main", origin]);
    await writeFile(join(origin, "a.txt"), "x");
    execFileSync("git", ["-C", origin, "add", "."]);
    execFileSync("git", ["-C", origin, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "i"]);
    ctx.detectAdo = () => ({ org: "acme", pat: "pat-1234567890", profile: "p", projects: [] });
    fakeRoutes["https://dev.azure.com/acme/Web/_apis/git/repositories?api-version=7.1"] = {
      value: [{ id: "r1", name: "frontend", remoteUrl: origin, defaultBranch: "refs/heads/main" }],
    };

    const res = await fetch(`${base}/api/ado/clone`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ project: "Web", repo: "frontend" }),
    });
    expect(res.status).toBe(200);
    // ADO's default branch becomes the base threads branch from.
    expect(store.get().repos.frontend).toEqual({ path: join(dir, "repos", "frontend"), base: "main" });
    expect(existsSync(join(dir, "repos", "frontend", "a.txt"))).toBe(true);

    const missing = await fetch(`${base}/api/ado/clone`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ project: "Web", repo: "ghost" }),
    });
    expect(missing.status).toBe(404);
  });

  it("uses the ado CLI setup and never leaks its PAT", async () => {
    let seenAuth: string | null = null;
    ctx.detectAdo = () => ({ org: "acme", pat: "cli-pat-123", profile: "social", projects: ["Social"], defaultProject: "Social" });
    ctx.fetch = async (_url, init) => {
      seenAuth = new Headers(init?.headers).get("authorization");
      return Response.json({ value: [{ id: "p", name: "Social" }] });
    };
    const statusRes = await fetch(`${base}/api/ado/status`);
    const status = (await statusRes.json()) as Record<string, unknown>;
    expect(status).toEqual({ connected: true, org: "acme", profile: "social", projects: ["Social"], defaultProject: "Social" });
    expect(JSON.stringify(status)).not.toContain("cli-pat");

    expect((await fetch(`${base}/api/ado/projects`)).status).toBe(200);
    expect(seenAuth).toBe(`Basic ${Buffer.from(":cli-pat-123").toString("base64")}`);
  });

  it("lists detected agents, caching the slow probe until refresh=1", async () => {
    let calls = 0;
    ctx.detectAgents = async () => {
      calls++;
      return [{ id: "opencode", name: "OpenCode", installed: true, version: "2.0.31", supported: true, ready: true }];
    };
    const first = (await (await fetch(`${base}/api/agents`)).json()) as { id: string }[];
    await fetch(`${base}/api/agents`);
    expect(first[0]?.id).toBe("opencode");
    expect(calls).toBe(1);
    await fetch(`${base}/api/agents?refresh=1`);
    expect(calls).toBe(2);
  });
});
