import { existsSync, readFileSync, statSync } from "node:fs";
import { rename, unlink, writeFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import type { AgentDriverKind } from "./config.js";
import type { ContextFooter } from "./handler.js";
import { PERSONA_NAME, type Persona } from "./personas.js";
import type { RepoConfig } from "./workspace.js";

export interface Settings {
  agentDriver: AgentDriverKind;
  models: { pi?: string };
  repos: Record<string, RepoConfig>;
  allowedSpaces: string[];
  contextFooter: ContextFooter;
  autoCompactAt: number;
  personas: Persona[];
  hostPrompt?: string;
}

const DEFAULTS = { contextFooter: "every5" as ContextFooter, autoCompactAt: 85, personas: [] as Persona[] };

const REPO_NAME = /^[a-zA-Z0-9._-]+$/;

function stripPersonaRuntime(p: Persona): Persona {
  const { driver: _d, agent: _a, ...rest } = p as Persona & { driver?: unknown; agent?: unknown };
  return rest;
}

function validate(s: Settings): void {
  if (s.agentDriver !== "pi") {
    throw new Error(`agentDriver must be "pi"`);
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
    if (p.driver !== undefined && p.driver !== "pi") throw new Error(`agent @${p.name}: driver must be pi`);
    if (p.model !== undefined && typeof p.model !== "string") throw new Error(`agent @${p.name}: model must be text`);
    if (p.listen !== undefined && p.listen !== "mentions" && p.listen !== "all") throw new Error(`agent @${p.name}: listen must be mentions or all`);
    if (p.respondTo !== undefined && p.respondTo !== "anyone" && p.respondTo !== "people") throw new Error(`agent @${p.name}: respondTo must be anyone or people`);
  }
  for (const space of s.allowedSpaces) {
    if (!/^spaces\/[^/\s]+$/.test(space)) throw new Error(`"${space}" is not a space name (spaces/XXXX)`);
  }
}

export class SettingsStore {
  private filePath: string;
  private current: Settings;
  private listeners: ((s: Settings) => void)[] = [];

  constructor(filePath: string, defaults: Omit<Settings, keyof typeof DEFAULTS> & Partial<Settings>) {
    this.filePath = filePath;
    let saved: Partial<Settings> & { models?: { pi?: string; opencode?: string; claude?: string } } = {};
    try {
      saved = JSON.parse(readFileSync(filePath, "utf8")) as typeof saved;
    } catch {
      saved = {};
    }
    const merged = { ...DEFAULTS, ...defaults, ...saved };
    const personas = (merged.personas ?? []).map(stripPersonaRuntime);
    const piModel = saved.models?.pi ?? defaults.models?.pi;
    this.current = {
      agentDriver: "pi",
      models: piModel ? { pi: piModel } : {},
      repos: merged.repos,
      allowedSpaces: merged.allowedSpaces,
      contextFooter: merged.contextFooter,
      autoCompactAt: merged.autoCompactAt,
      personas,
      ...(typeof merged.hostPrompt === "string" && merged.hostPrompt.trim() ? { hostPrompt: merged.hostPrompt.trim() } : {}),
    };
  }

  get(): Settings {
    return this.current;
  }

  onChange(listener: (s: Settings) => void): void {
    this.listeners.push(listener);
  }

  async update(patch: Partial<Settings>): Promise<Settings> {
    const next: Settings = {
      ...this.current,
      ...patch,
      agentDriver: "pi",
      models: patch.models ? { pi: patch.models.pi } : this.current.models,
      personas: (patch.personas ?? this.current.personas).map(stripPersonaRuntime),
    };
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
