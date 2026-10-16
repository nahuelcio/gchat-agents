import { existsSync, readFileSync, statSync } from "node:fs";
import { rename, unlink, writeFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import type { AgentDriverKind } from "./config.js";
import type { RepoConfig } from "./workspace.js";

/** Everything the control plane can change at runtime. Persisted in DATA_DIR/config.json. */
export interface Settings {
  agentDriver: AgentDriverKind;
  models: { opencode?: string; claude?: string };
  repos: Record<string, RepoConfig>;
  allowedSpaces: string[];
}

const REPO_NAME = /^[a-zA-Z0-9._-]+$/;

function validate(s: Settings): void {
  if (s.agentDriver !== "opencode" && s.agentDriver !== "claude") {
    throw new Error(`agentDriver must be "opencode" or "claude"`);
  }
  for (const [name, repo] of Object.entries(s.repos)) {
    if (!REPO_NAME.test(name)) throw new Error(`"${name}" is not a valid repo name (letters, digits, . _ -)`);
    if (typeof repo?.path !== "string" || !isAbsolute(repo.path)) {
      throw new Error(`repo "${name}": path must be an absolute directory`);
    }
    if (!existsSync(repo.path) || !statSync(repo.path).isDirectory()) {
      throw new Error(`repo "${name}": ${repo.path} does not exist`);
    }
    if (repo.up !== undefined && typeof repo.up !== "string") throw new Error(`repo "${name}": up must be a string`);
    if (repo.base !== undefined && !/^[\w./-]+$/.test(repo.base)) throw new Error(`repo "${name}": "${repo.base}" is not a branch name`);
  }
  for (const space of s.allowedSpaces) {
    if (!/^spaces\/[^/\s]+$/.test(space)) throw new Error(`"${space}" is not a space name (spaces/XXXX)`);
  }
}

export class SettingsStore {
  private filePath: string;
  private current: Settings;
  private listeners: ((s: Settings) => void)[] = [];

  /** `defaults` come from env; anything saved in the file wins. */
  constructor(filePath: string, defaults: Settings) {
    this.filePath = filePath;
    let saved: Partial<Settings> = {};
    try {
      saved = JSON.parse(readFileSync(filePath, "utf8")) as Partial<Settings>;
    } catch {
      // missing or corrupt file -> env defaults
    }
    // Only known fields: files from older versions may carry removed ones.
    const { agentDriver, models, repos, allowedSpaces } = { ...defaults, ...saved };
    this.current = { agentDriver, models, repos, allowedSpaces };
  }

  get(): Settings {
    return this.current;
  }

  onChange(listener: (s: Settings) => void): void {
    this.listeners.push(listener);
  }

  /** Replaces the given fields, validates, persists atomically, then notifies. */
  async update(patch: Partial<Settings>): Promise<Settings> {
    const next: Settings = { ...this.current, ...patch };
    validate(next);
    const tmp = `${this.filePath}.${Date.now()}.tmp`;
    try {
      await writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`, "utf8");
      await rename(tmp, this.filePath);
    } catch (err) {
      await unlink(tmp).catch(() => {});
      throw err;
    }
    this.current = next;
    for (const listener of this.listeners) listener(next);
    return next;
  }
}
