import { execFile, spawn, type ChildProcess } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

export interface RepoConfig {
  /** Local clone the worktrees are created from. */
  path: string;
  /** Command that starts the app; `{port}` is replaced with a free port (also exported as PORT). */
  up?: string;
  /** Branch new thread branches start from (fetched from origin first). Omitted = the clone's HEAD. */
  base?: string;
}

interface RunningApp {
  child: ChildProcess;
  port: number;
}

export interface GitChangeFile {
  path: string;
  /** Two-char porcelain code, e.g. "M ", " M", "??". */
  status: string;
}

export interface GitChangeSummary {
  clean: boolean;
  staged: number;
  unstaged: number;
  untracked: number;
  files: GitChangeFile[];
}

const CHANGE_FILE_LIMIT = 12;

/** Parses `git status --porcelain` into counts + a short file list. */
export async function gitChanges(worktree: string): Promise<GitChangeSummary | null> {
  if (!existsSync(worktree)) return null;
  let stdout: string;
  try {
    ({ stdout } = await run("git", ["-C", worktree, "status", "--porcelain", "-uall"], { timeout: 8_000, encoding: "utf8" }));
  } catch {
    return null;
  }
  const files: GitChangeFile[] = [];
  let staged = 0;
  let unstaged = 0;
  let untracked = 0;
  for (const line of stdout.split("\n")) {
    if (line.length < 3) continue;
    const status = line.slice(0, 2);
    const path = line.slice(3).replace(/^"(.*)"$/, "$1").split(" -> ").pop() ?? line.slice(3);
    files.push({ path, status });
    if (status === "??") untracked++;
    else {
      if (status[0] && status[0] !== " " && status[0] !== "?") staged++;
      if (status[1] && status[1] !== " " && status[1] !== "?") unstaged++;
    }
  }
  return {
    clean: files.length === 0,
    staged,
    unstaged,
    untracked,
    files: files.slice(0, CHANGE_FILE_LIMIT),
  };
}

/** Filesystem-safe id for a Chat thread: last path segment, lowercased, [a-z0-9-]. */
export function threadSlug(threadKey: string): string {
  const last = threadKey.split("/").pop() ?? threadKey;
  return last.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "thread";
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const address = srv.address();
      const port = typeof address === "object" && address ? address.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

/**
 * One git worktree (branch chat/<slug>) and at most one running app per Chat thread.
 * Only commands from the repo config ever run here, never text from Chat.
 */
export class Workspaces {
  private root: string;
  private repos: Record<string, RepoConfig>;
  // ponytail: in-memory only — apps die with the bridge (killAll on shutdown).
  private apps: Map<string, RunningApp> = new Map();

  constructor(root: string, repos: Record<string, RepoConfig>) {
    // Absolute on purpose: worktree paths go to `git -C <repo>`, which would resolve a
    // relative one against the repo (worktree created inside the clone, agent cwd missing).
    this.root = resolve(root);
    this.repos = repos;
  }

  /** Swap the repo list at runtime (control plane edits); running apps keep going. */
  setRepos(repos: Record<string, RepoConfig>): void {
    this.repos = repos;
  }

  repoNames(): string[] {
    return Object.keys(this.repos);
  }

  private repo(name: string): RepoConfig {
    const repo = this.repos[name];
    if (!repo) throw new Error(`unknown repo "${name}" (configured: ${this.repoNames().join(", ") || "none"})`);
    return repo;
  }

  async create(repoName: string, slug: string): Promise<{ worktree: string; branch: string }> {
    const repo = this.repo(repoName);
    const worktree = join(this.root, `${repoName}-${slug}`);
    const branch = `chat/${slug}`;
    if (existsSync(worktree)) return { worktree, branch };
    mkdirSync(this.root, { recursive: true });
    const branchExists = await run("git", ["-C", repo.path, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`])
      .then(() => true, () => false);
    const args = branchExists
      ? ["-C", repo.path, "worktree", "add", worktree, branch]
      : ["-C", repo.path, "worktree", "add", "-b", branch, worktree, ...(repo.base ? [await this.startPoint(repo)] : [])];
    await run("git", args);
    return { worktree, branch };
  }

  /** origin/<base> refreshed by a fetch; falls back to a local <base> for clones without that remote branch. */
  private async startPoint(repo: RepoConfig): Promise<string> {
    const base = repo.base!;
    const exists = (ref: string) =>
      run("git", ["-C", repo.path, "rev-parse", "--verify", "--quiet", `${ref}^{commit}`]).then(() => true, () => false);
    // ponytail: a failed fetch (offline) just means branching from the last fetched origin/<base>.
    await run("git", ["-C", repo.path, "fetch", "--quiet", "origin", base], { timeout: 120_000 }).catch(() => {});
    if (await exists(`refs/remotes/origin/${base}`)) return `origin/${base}`;
    if (await exists(`refs/heads/${base}`)) return base;
    throw new Error(`base branch "${base}" not found in origin or locally`);
  }

  /** Removes the worktree; the branch (and its commits) stays in the repo. */
  async remove(repoName: string, worktree: string): Promise<void> {
    await run("git", ["-C", this.repo(repoName).path, "worktree", "remove", "--force", worktree]);
  }

  private logFile(key: string): string {
    return join(this.root, `${key}.log`);
  }

  async up(key: string, repoName: string, worktree: string): Promise<{ port: number }> {
    const command = this.repo(repoName).up;
    if (!command) throw new Error(`repo "${repoName}" has no "up" command configured`);
    if (this.isUp(key)) return { port: this.apps.get(key)!.port };
    mkdirSync(this.root, { recursive: true });
    const port = await freePort();
    const log = openSync(this.logFile(key), "w");
    try {
      // detached: own process group, so down() can kill the dev server's children too.
      const child = spawn("sh", ["-c", command.replaceAll("{port}", String(port))], {
        cwd: worktree,
        detached: true,
        stdio: ["ignore", log, log],
        env: { ...process.env, PORT: String(port) },
      });
      child.on("exit", () => {
        if (this.apps.get(key)?.child === child) this.apps.delete(key);
      });
      this.apps.set(key, { child, port });
    } finally {
      closeSync(log); // the child holds its own copy
    }
    return { port };
  }

  port(key: string): number | undefined {
    return this.apps.get(key)?.port;
  }

  isUp(key: string): boolean {
    return this.apps.has(key);
  }

  down(key: string): boolean {
    const app = this.apps.get(key);
    if (!app?.child.pid) return false;
    try {
      process.kill(-app.child.pid, "SIGTERM");
    } catch {
      app.child.kill("SIGTERM"); // group already gone
    }
    return true;
  }

  killAll(): void {
    for (const key of [...this.apps.keys()]) this.down(key);
  }

  /**
   * Short porcelain summary for the team-chat context panel.
   * Returns null when the path is not a git worktree.
   */
  async changes(worktree: string): Promise<GitChangeSummary | null> {
    return gitChanges(worktree);
  }

  logs(key: string, lines = 40): string {
    try {
      return readFileSync(this.logFile(key), "utf8").split("\n").slice(-lines - 1).join("\n").trim();
    } catch {
      return "";
    }
  }
}
