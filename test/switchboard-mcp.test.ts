import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAdminServer } from "../src/admin.js";
import { Scheduler, ScheduleStore } from "../src/schedules.js";
import { SettingsStore } from "../src/settings.js";
import { SessionStore } from "../src/store.js";
import { handleRpc, runTool } from "../src/switchboard-mcp.js";
import { Workspaces } from "../src/workspace.js";

describe("switchboard MCP tools/list", () => {
  it("exposes repo, app, schedule and work-item tools", async () => {
    const framed = await handleRpc({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    for (const name of [
      "link_work_item",
      "attach_repo",
      "detach_repo",
      "thread_status",
      "start_app",
      "stop_app",
      "list_schedules",
      "create_schedule",
      "delete_schedule",
    ]) {
      expect(framed).toContain(name);
    }
  });
});

describe("switchboard MCP → admin", () => {
  let base: string;
  let close: () => Promise<void>;
  let sessions: SessionStore;
  let dir: string;
  let repoPath: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "gchat-mcp-"));
    repoPath = join(dir, "app");
    mkdirSync(repoPath);
    execFileSync("git", ["init", "-q", "-b", "main", repoPath]);
    await writeFile(join(repoPath, "README.md"), "hi\n");
    execFileSync("git", ["-C", repoPath, "add", "."]);
    execFileSync("git", ["-C", repoPath, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"]);

    sessions = new SessionStore(join(dir, "sessions.json"));
    await sessions.update("share/team-1", "team-chat", {});
    const settings = new SettingsStore(join(dir, "config.json"), {
      agentDriver: "opencode",
      models: {},
      agents: {},
      repos: { app: { path: repoPath } },
      allowedSpaces: [],
    });
    const schedules = new ScheduleStore(join(dir, "schedules.json"));
    const scheduler = new Scheduler(schedules, async () => true);
    const server = createAdminServer(settings, {
      store: sessions,
      workspaces: new Workspaces(join(dir, "wt"), settings.get().repos),
      schedules,
      scheduler,
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    close = () => new Promise((r) => server.close(() => r()));
  });
  afterEach(() => close());

  const env = () => ({ SWITCHBOARD_ADMIN_URL: base, SWITCHBOARD_THREAD_KEY: "share/team-1" });

  it("links and clears a work item", async () => {
    expect(await runTool("link_work_item", { id: 42424 }, env())).toContain("#42424");
    expect(sessions.get("share/team-1")?.workItemId).toBe(42424);
    expect(await runTool("clear_work_item", {}, env())).toContain("Cleared");
    expect(sessions.get("share/team-1")?.workItemId).toBeUndefined();
  });

  it("attaches and detaches a repo, and reports status", async () => {
    expect(await runTool("list_repos", {}, env())).toContain("app");
    expect(await runTool("attach_repo", { repo: "app" }, env())).toMatch(/Worktree:/);
    expect(sessions.get("share/team-1")?.repo).toBe("app");
    const status = await runTool("thread_status", {}, env());
    expect(status).toContain("Repo: app");
    expect(status).toContain("Work item: none");
    expect(await runTool("detach_repo", {}, env())).toMatch(/Detached|kept/);
    expect(sessions.get("share/team-1")?.repo).toBeUndefined();
  });

  it("creates, lists and deletes a schedule using the thread space", async () => {
    const created = await runTool(
      "create_schedule",
      { cron: "0 9 * * 1-5", prompt: "Summarize yesterday", name: "Daily summary" },
      env(),
    );
    expect(created).toMatch(/Scheduled \w+/);
    const list = await runTool("list_schedules", {}, env());
    expect(list).toContain("Daily summary");
    const id = created.match(/Scheduled (\w+)/)?.[1];
    expect(id).toBeTruthy();
    expect(await runTool("delete_schedule", { id }, env())).toContain(id!);
    expect(await runTool("list_schedules", {}, env())).toBe("No schedules.");
  });
});
