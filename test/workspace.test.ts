import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { gitChanges, threadSlug, Workspaces } from "../src/workspace.js";
import { workItemFromBranch } from "../src/team.js";

let dir: string;
let repo: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "gchat-ws-"));
  repo = join(dir, "repo");
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  await writeFile(join(repo, "README.md"), "hi\n");
  execFileSync("git", ["-C", repo, "add", "."]);
  execFileSync("git", ["-C", repo, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"]);
});

function until(check: () => boolean, ms = 3000): Promise<void> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (check()) return resolve();
      if (Date.now() - start > ms) return reject(new Error("timed out"));
      setTimeout(tick, 25);
    };
    tick();
  });
}

describe("threadSlug", () => {
  it("uses the last segment of a thread name, sanitized", () => {
    expect(threadSlug("spaces/AAA/threads/Xy_9.z")).toBe("xy-9-z");
  });
});

describe("workItemFromBranch", () => {
  it("pulls a work item id out of common branch shapes", () => {
    expect(workItemFromBranch("12345-fix-export")).toBe(12345);
    expect(workItemFromBranch("feature/AB#98765-login")).toBe(98765);
    expect(workItemFromBranch("chat/team-0001")).toBeUndefined();
  });
});

describe("gitChanges", () => {
  it("summarizes porcelain status for a dirty worktree", async () => {
    await writeFile(join(repo, "dirty.txt"), "x\n");
    const summary = await gitChanges(repo);
    expect(summary?.clean).toBe(false);
    expect(summary?.untracked).toBeGreaterThanOrEqual(1);
    expect(summary?.files.some((f) => f.path === "dirty.txt")).toBe(true);
  });
});

describe("Workspaces", () => {
  it("creates a worktree on chat/<slug>, reuses it, and removes it keeping the branch", async () => {
    const ws = new Workspaces(join(dir, "wt"), { app: { path: repo } });
    const created = await ws.create("app", "t1");
    expect(created.branch).toBe("chat/t1");
    expect(existsSync(join(created.worktree, "README.md"))).toBe(true);

    await ws.remove("app", created.worktree);
    expect(existsSync(created.worktree)).toBe(false);
    const again = await ws.create("app", "t1"); // branch already exists: reattach
    expect(again.worktree).toBe(created.worktree);
    expect(existsSync(join(again.worktree, "README.md"))).toBe(true);
  });

  it("branches from origin/<base> after fetching, so threads start from the latest base", async () => {
    // Clone of `repo`; then `repo` gets a new commit on a `dev` branch the clone has never seen.
    const clone = join(dir, "clone");
    execFileSync("git", ["clone", "-q", repo, clone]);
    execFileSync("git", ["-C", repo, "checkout", "-qb", "dev"]);
    await writeFile(join(repo, "dev.txt"), "dev\n");
    execFileSync("git", ["-C", repo, "add", "."]);
    execFileSync("git", ["-C", repo, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "dev work"]);

    const ws = new Workspaces(join(dir, "wt"), { app: { path: clone, base: "dev" } });
    const { worktree } = await ws.create("app", "t9");
    expect(existsSync(join(worktree, "dev.txt"))).toBe(true);
  });

  it("fails clearly when the base branch does not exist", async () => {
    const ws = new Workspaces(join(dir, "wt"), { app: { path: repo, base: "nope" } });
    await expect(ws.create("app", "t10")).rejects.toThrow(/base branch "nope"/);
  });

  it("puts worktrees under its root even when the root is relative (git resolves -C paths against the repo)", async () => {
    const { relative } = await import("node:path");
    const ws = new Workspaces(relative(process.cwd(), join(dir, "wt")), { app: { path: repo } });
    const { worktree } = await ws.create("app", "rel1");
    expect(worktree).toBe(join(dir, "wt", "app-rel1"));
    expect(existsSync(join(worktree, "README.md"))).toBe(true);
    const listed = execFileSync("git", ["-C", repo, "worktree", "list", "--porcelain"], { encoding: "utf8" });
    expect(listed).toContain(`worktree ${join(dir, "wt", "app-rel1")}\n`);
  });

  it("rejects unknown repos", async () => {
    const ws = new Workspaces(join(dir, "wt"), { app: { path: repo } });
    await expect(ws.create("nope", "t1")).rejects.toThrow(/unknown repo/);
  });

  it("runs the repo up command with a free {port}, captures logs, and stops it", async () => {
    const ws = new Workspaces(join(dir, "wt"), {
      app: { path: repo, up: "echo started on {port}; sleep 30" },
    });
    const { worktree } = await ws.create("app", "t2");
    const { port } = await ws.up("t2", "app", worktree);
    expect(port).toBeGreaterThan(0);
    await until(() => ws.logs("t2").includes(`started on ${port}`));
    expect(ws.isUp("t2")).toBe(true);
    expect(ws.down("t2")).toBe(true);
    await until(() => !ws.isUp("t2"));
  });

  it("refuses up when the repo has no up command", async () => {
    const ws = new Workspaces(join(dir, "wt"), { app: { path: repo } });
    const { worktree } = await ws.create("app", "t3");
    await expect(ws.up("t3", "app", worktree)).rejects.toThrow(/no "up" command/);
  });
});
