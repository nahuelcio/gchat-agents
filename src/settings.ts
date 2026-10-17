import { existsSync, readFileSync, statSync } from "node:fs";
import { rename, unlink, writeFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import type { AgentDriverKind } from "./config.js";
import type { ContextFooter } from "./handler.js";
import { PERSONA_NAME, type Persona } from "./personas.js";
import type { RepoConfig } from "./workspace.js";

/** Everything the control plane can change at runtime. Persisted in DATA_DIR/config.json. */
export interface Settings {
  agentDriver: AgentDriverKind;
  models: { opencode?: string; claude?: string };
  agents: { opencode?: string };
  repos: Record<string, RepoConfig>;
  allowedSpaces: string[];
  /** When agent replies in Chat carry the context footer. */
  contextFooter: ContextFooter;
  /** Compact a thread automatically at this context percent; 0 = never. */
  autoCompactAt: number;
  /** Named agents people can @mention inside a thread. */
  personas: Persona[];
}

const DEFAULTS = { contextFooter: "every5" as ContextFooter, autoCompactAt: 85, personas: [] as Persona[] };

const REPO_NAME = /^[a-zA-Z0-9._-]+$/;

function validate(s: Settings): void {
  if (s.agentDriver !== "opencode" && s.agentDriver !== "claude") {
    throw new Error(`agentDriver must be "opencode" or "claude"`);
  }
  if (s.agents?.opencode !== undefined && (typeof s.agents.opencode !== "string" || !/^[\w.-]+$/.test(s.agents.opencode))) {
    throw new Error(`agents.opencode must be a simple agent id (letters, digits, . _ -)`);
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
  if (!["every", "every5", "above60", "never"].includes(s.contextFooter)) throw new Error(`contextFooter: "${s.contextFooter}" is not valid`);
  if (!Number.isInteger(s.autoCompactAt) || s.autoCompactAt < 0 || s.autoCompactAt > 100) throw new Error("autoCompactAt must be 0-100");
  const names = new Set<string>();
  for (const p of s.personas) {
    if (typeof p?.name !== "string" || !PERSONA_NAME.test(p.name)) throw new Error(`agent "${p?.name}": use letters, digits, - or _ (no spaces, max 32)`);
    if (names.has(p.name.toLowerCase())) throw new Error(`agent @${p.name} is defined twice`);
    names.add(p.name.toLowerCase());
    if (typeof p.prompt !== "string") throw new Error(`agent @${p.name}: prompt must be text`);
    if (p.driver !== undefined && p.driver !== "opencode" && p.driver !== "claude") throw new Error(`agent @${p.name}: driver must be opencode or claude`);
    if (p.model !== undefined && typeof p.model !== "string") throw new Error(`agent @${p.name}: model must be text`);
    if (p.agent !== undefined && (typeof p.agent !== "string" || !/^[\w.-]+$/.test(p.agent))) throw new Error(`agent @${p.name}: OpenCode agent must be a simple id`);
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
  constructor(filePath: string, defaults: Omit<Settings, keyof typeof DEFAULTS> & Partial<Settings>) {
    this.filePath = filePath;
    let saved: Partial<Settings> = {};
    try {
      saved = JSON.parse(readFileSync(filePath, "utf8")) as Partial<Settings>;
    } catch {
      // missing or corrupt file -> env defaults
    }
    // Only known fields: files from older versions may carry removed ones.
    const merged = { ...DEFAULTS, ...defaults, ...saved };
    const { agentDriver, models, repos, allowedSpaces, contextFooter, autoCompactAt, personas } = merged;
    const agents = { ...(defaults.agents ?? {}), ...(saved.agents ?? {}) };
    this.current = { agentDriver, models, agents, repos, allowedSpaces, contextFooter, autoCompactAt, personas };
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
