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
import { EchoDriver } from "../src/driver/echo.js";
import { TurnQueue } from "../src/queue.js";
import { Scheduler, ScheduleStore } from "../src/schedules.js";
import { GoogleConnection } from "../src/google.js";

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
    agents: {},
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

  it("team chat: owner sends with every command, history is listed and survives a new store", async () => {
    const { TranscriptStore } = await import("../src/transcripts.js");
    ctx.transcripts = new TranscriptStore(join(dir, "transcripts"));
    ctx.handler = {
      verifier: { verify: async () => {} },
      driver: new EchoDriver(),
      chat: { postMessage: async () => {} },
      store: ctx.store!,
      queue: new TurnQueue(),
      config: { allowedSpaces: [], workdir: dir },
      options: () => ({ contextFooter: "never", autoCompactAt: 0, defaultModel: "m1" }),
    };
    const post = (text: string) =>
      fetch(`${base}/api/team/send`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ thread: "team-0001", text, name: "Nahuel" }) }).then((r) => r.json());
    const loadThread = () =>
      fetch(`${base}/api/team/thread?thread=team-0001`).then((r) => r.json() as Promise<{ messages: { text: string; bot: boolean }[]; busy: boolean }>);
    const waitFor = async (ok: (t: Awaited<ReturnType<typeof loadThread>>) => boolean) => {
      const deadline = Date.now() + 2000;
      let last: Awaited<ReturnType<typeof loadThread>> | undefined;
      while (Date.now() < deadline) {
        last = await loadThread();
        if (ok(last)) return last;
        await new Promise((r) => setTimeout(r, 15));
      }
      throw new Error(`timeout: ${JSON.stringify(last)}`);
    };

    expect(await post("hello")).toMatchObject({ ok: true, replies: [] });
    await waitFor((t) => !t.busy && t.messages.some((m) => m.bot && m.text === "Echo: Nahuel: hello"));
    expect(await post("/help")).toMatchObject({ ok: true, replies: [] });
    const afterHelp = await waitFor((t) => !t.busy && t.messages.some((m) => m.bot && m.text.includes("/repo")));
    expect(afterHelp.messages.find((m) => m.bot && m.text.includes("/repo"))?.text).toContain("/repo"); // owner is not restricted

    ctx.transcripts = new TranscriptStore(join(dir, "transcripts")); // like a restart
    const threads = (await (await fetch(`${base}/api/team/threads`)).json()) as { id: string; title: string; count: number }[];
    expect(threads).toEqual([expect.objectContaining({ id: "team-0001", title: "hello", count: 4 })]);
    const thread = await loadThread();
    expect(thread.messages[1]?.text).toBe("Echo: Nahuel: hello");
  });

  it("creates, pauses, runs and deletes schedules", async () => {
    const schedules = new ScheduleStore(join(dir, "schedules.json"));
    let ran = 0;
    ctx.schedules = schedules;
    ctx.scheduler = new Scheduler(schedules, async () => {
      ran++;
      return true;
    });
    const call = (path: string, body: unknown) =>
      fetch(`${base}/api/schedules${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

    const created = (await (await call("", { prompt: "Summarize commits", cron: "0 9 * * 1-5", space: "spaces/AAA" })).json()) as { id: string; when: string }[];
    expect(created[0]?.when).toBe("Weekdays at 09:00");
    const id = created[0]!.id;
    await call("/update", { id, enabled: false });
    expect(schedules.get(id)?.enabled).toBe(false);
    await call("/run", { id });
    await new Promise((r) => setTimeout(r, 20));
    expect(ran).toBe(1);
    expect((await call("", { prompt: "x", cron: "bad", space: "spaces/AAA" })).status).toBe(400);
    await call("/delete", { id });
    expect(schedules.all()).toHaveLength(0);
  });

  it("serves a schedule job log and clears it on delete", async () => {
    const { TranscriptStore } = await import("../src/transcripts.js");
    const schedules = new ScheduleStore(join(dir, "schedules.json"));
    const transcripts = new TranscriptStore(join(dir, "transcripts"));
    ctx.schedules = schedules;
    ctx.scheduler = new Scheduler(schedules, async () => true);
    ctx.transcripts = transcripts;

    const created = (await (
      await fetch(`${base}/api/schedules`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prompt: "Summarize commits", cron: "0 9 * * 1-5", space: "spaces/AAA" }),
      })
    ).json()) as { id: string }[];
    const id = created[0]!.id;
    expect((await fetch(`${base}/api/schedules/log?id=${id}`)).status).toBe(200);
    expect(await (await fetch(`${base}/api/schedules/log?id=${id}`)).json()).toEqual({ messages: [] });
    expect((await fetch(`${base}/api/schedules/log?id=missing`)).status).toBe(404);

    await transcripts.append(`schedule/${id}`, [
      { author: 'Schedule "Summarize commits"', text: "Summarize commits", bot: false },
      { author: "Switchi", text: "Done.", bot: true },
    ]);
    const log = (await (await fetch(`${base}/api/schedules/log?id=${id}`)).json()) as { messages: { text: string; bot: boolean }[] };
    expect(log.messages).toEqual([
      expect.objectContaining({ text: "Summarize commits", bot: false }),
      expect.objectContaining({ text: "Done.", bot: true }),
    ]);

    await fetch(`${base}/api/schedules/delete`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id }),
    });
    expect(transcripts.get(`schedule/${id}`)).toEqual([]);
  });

  it("suggests a schedule from plain language via the agent", async () => {
    const schedules = new ScheduleStore(join(dir, "schedules.json"));
    ctx.schedules = schedules;
    ctx.scheduler = new Scheduler(schedules, async () => true);
    ctx.handler = {
      verifier: { verify: async () => {} },
      driver: {
        runTurn: async () => ({
          reply: JSON.stringify({ name: "Standup", prompt: "Summarize yesterday's commits", cron: "0 9 * * 1-5" }),
        }),
      },
      chat: { postMessage: async () => {} },
      store: ctx.store!,
      queue: new TurnQueue(),
      config: { allowedSpaces: [], workdir: dir },
    };
    const res = await fetch(`${base}/api/schedules/suggest`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "weekdays at 9 summarize commits" }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      name: "Standup",
      prompt: "Summarize yesterday's commits",
      cron: "0 9 * * 1-5",
      when: "Weekdays at 09:00",
    });
    expect((await fetch(`${base}/api/schedules/suggest`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status).toBe(400);
  });

  it("connects Google Chat from a pasted key without ever returning the key, and sends a test message", async () => {
    const posted: string[] = [];
    ctx.google = new GoogleConnection(join(dir, "google-sa.json"), undefined, () => ({ postMessage: async (space) => void posted.push(space) }));
    ctx.publicUrl = "https://abc.opentunnel.xyz";
    const post = (path: string, body: unknown) =>
      fetch(`${base}/api/google${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

    expect(await (await fetch(`${base}/api/google`)).json()).toEqual({ configured: false, source: "none", endpoint: "https://abc.opentunnel.xyz/google/chat" });
    const key = JSON.stringify({ type: "service_account", project_id: "p", client_email: "b@p.iam.gserviceaccount.com", private_key: "SECRET-PEM" });
    const res = await post("/key", { key });
    const text = await res.text();
    expect(res.status).toBe(200);
    expect(text).toContain("b@p.iam.gserviceaccount.com");
    expect(text).not.toContain("SECRET-PEM");

    expect((await post("/test", { space: "nope" })).status).toBe(400);
    expect((await post("/test", { space: "spaces/AAA" })).status).toBe(200);
    expect(posted).toEqual(["spaces/AAA"]);
  });

  it("archives, restores and deletes team threads (history and session gone, worktree removed)", async () => {
    const { TranscriptStore } = await import("../src/transcripts.js");
    ctx.transcripts = new TranscriptStore(join(dir, "transcripts"));
    ctx.handler = {
      verifier: { verify: async () => {} },
      driver: new EchoDriver(),
      chat: { postMessage: async () => {} },
      store: ctx.store!,
      queue: new TurnQueue(),
      config: { allowedSpaces: [], workdir: dir },
    };
    const post = (path: string, body: unknown) =>
      fetch(`${base}/api/team/${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const list = async (archived = false) =>
      ((await (await fetch(`${base}/api/team/threads${archived ? "?archived=1" : ""}`)).json()) as { id: string }[]).map((t) => t.id);

    await post("send", { thread: "keep-0001", text: "a", name: "N" });
    await post("send", { thread: "gone-0001", text: "b", name: "N" });
    await post("archive", { thread: "keep-0001", archived: true });
    expect(await list()).toEqual(["gone-0001"]);
    expect(await list(true)).toEqual(["keep-0001"]);
    await post("archive", { thread: "keep-0001", archived: false });

    expect((await post("delete", { thread: "gone-0001" })).status).toBe(200);
    expect(await list()).toEqual(["keep-0001"]);
    expect(ctx.store!.get("share/gone-0001")).toBeUndefined();
  });
});
