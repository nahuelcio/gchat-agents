import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export type PiToolDef = {
  name: string;
  label?: string;
  description: string;
  parameters: unknown;
  annotations?: { destructiveHint?: boolean; readOnlyHint?: boolean };
  execute: (toolCallId: string, params: unknown, signal: AbortSignal | undefined, onUpdate: unknown, ctx: unknown) => Promise<{ content?: { type: string; text?: string; data?: string; mimeType?: string }[]; isError?: boolean; details?: unknown }>;
};

export type PiProviderDef = {
  id: string;
  name?: string;
  getModels?: () => readonly { id: string }[];
};

export type PiCommand = { name: string; description: string; handler: (args: string, ctx: unknown) => Promise<unknown> | unknown };
export type PiHook = { event: string; handler: (payload: unknown) => Promise<unknown> | unknown };
export type LoadedPackage = { name: string; spec: string; group: string; tools: PiToolDef[]; skills: string[]; providers: PiProviderDef[]; commands: PiCommand[]; hooks: PiHook[]; ignored: string[]; error?: string };

type Saved = { packages: { name: string; spec: string }[] };

const NPM_NAME = /^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i;
const GIT_SPEC = /^(?:github:|git\+https:\/\/github\.com\/|https:\/\/github\.com\/)[\w.-]+\/[\w.-]+(?:\.git)?(?:#[\w./-]+)?$/;

export function packageName(spec: string) {
  const s = spec.trim().replace(/^npm:/, "");
  const at = s.lastIndexOf("@");
  return at > 0 ? s.slice(0, at) : s;
}

export function isGitSpec(spec: string) {
  return GIT_SPEC.test(spec.trim().replace(/\/+$/, ""));
}

export function dependencyAdded(before: readonly string[], deps: Record<string, string>, spec: string, hosts: readonly string[]) {
  const prior = new Set(before);
  const host = new Set(hosts);
  const added = Object.keys(deps).filter((n) => !prior.has(n) && !host.has(n));
  if (added.length === 1) return added[0];
  const tail = spec.split("#")[0].replace(/\.git$/, "").split("/").pop() ?? "";
  return Object.entries(deps).find(([n, v]) => !host.has(n) && (v.includes(spec) || n === tail || n.endsWith(`/${tail}`)))?.[0];
}

export const groupFor = (name: string) => `pi-${name.replace(/^@/, "").replace(/^pi-/, "").replace(/[^a-z0-9]+/gi, "-").toLowerCase()}`;

export const DEFAULT_PI_PACKAGES = [
  { name: "pi-mcp-adapter", spec: "pi-mcp-adapter" },
  { name: "@earendil-works/pi-claude-code", spec: "https://github.com/earendil-works/pi-claude-code" },
] as const;

const HOST_PACKAGES = ["typebox", "@earendil-works/pi-ai", "@earendil-works/pi-agent-core", "@earendil-works/pi-coding-agent", "@earendil-works/pi-tui"];
const PROBE_ABSENT = new Set(["registerMcpServer", "getMcpServers", "unregisterMcpServer"]);

export type McpServerConfig = { command?: string; args?: string[]; env?: Record<string, string> };
export type SwitchboardMcpConfig = { mcpServers: Record<string, McpServerConfig>; settings?: { hostConfigDiscovery?: "off" } };

const specKey = (spec: string) => spec.trim().replace(/\/+$/, "").replace(/\.git$/, "");

export function packageMatches(installed: { name: string; spec: string }, wanted: { name: string; spec: string }) {
  return installed.name === wanted.name || specKey(installed.spec) === specKey(wanted.spec);
}

export function pendingDefaults(installed: readonly { name: string; spec: string }[], seeded: readonly string[], defaults: readonly { name: string; spec: string }[] = DEFAULT_PI_PACKAGES) {
  const done = new Set(seeded);
  return defaults.filter((d) => !done.has(d.name) && !installed.some((p) => packageMatches(p, d)));
}

export function mcpConfigFromSettings(raw: string): SwitchboardMcpConfig {
  let parsed: { mcpServers?: { name?: string; command?: string; args?: string[]; env?: Record<string, string> }[]; mcp_servers?: { name?: string; command?: string; args?: string[]; env?: Record<string, string> }[] } = {};
  try {
    parsed = JSON.parse(raw) as typeof parsed;
  } catch {
    parsed = {};
  }
  const mcpServers: Record<string, McpServerConfig> = {};
  for (const server of [...(parsed.mcpServers ?? []), ...(parsed.mcp_servers ?? [])]) {
    if (!server?.name || !server.command) continue;
    mcpServers[server.name] = {
      command: server.command,
      ...(server.args?.length ? { args: server.args } : {}),
      ...(server.env && Object.keys(server.env).length ? { env: server.env } : {}),
    };
  }
  return { mcpServers, settings: { hostConfigDiscovery: "off" } };
}

export class PiPackages {
  readonly dir: string;
  readonly skillsDir: string;
  loaded: LoadedPackage[] = [];
  mcpConfig?: SwitchboardMcpConfig;

  constructor(dataDir: string) {
    this.dir = resolve(dataDir, "pi-packages");
    this.skillsDir = resolve(dataDir, "skills");
    mkdirSync(this.dir, { recursive: true });
  }

  private saved(): Saved {
    try {
      return JSON.parse(readFileSync(join(this.dir, "packages.json"), "utf8")) as Saved;
    } catch {
      return { packages: [] };
    }
  }

  private save(s: Saved) {
    writeFileSync(join(this.dir, "packages.json"), JSON.stringify(s, null, 2) + "\n");
  }

  private npm(args: string[]) {
    return new Promise<void>((ok, fail) => {
      const child = spawn("npm", args, { cwd: this.dir, shell: process.platform === "win32", stdio: ["ignore", "ignore", "pipe"] });
      let err = "";
      child.stderr.on("data", (c) => (err += String(c)));
      child.on("error", fail);
      child.on("close", (code) => (code === 0 ? ok() : fail(new Error(err.trim().split("\n").slice(-5).join("\n") || `npm exited ${code}`))));
    });
  }

  private dependencies(): Record<string, string> {
    try {
      const pkg = JSON.parse(readFileSync(join(this.dir, "package.json"), "utf8")) as { dependencies?: Record<string, string> };
      return pkg.dependencies ?? {};
    } catch {
      return {};
    }
  }

  private seededPath() {
    return join(this.dir, "defaults.seeded");
  }

  private seeded(): Set<string> {
    try {
      return new Set(readFileSync(this.seededPath(), "utf8").split("\n").map((l) => l.trim()).filter(Boolean));
    } catch {
      return new Set();
    }
  }

  private writeSeeded(names: Set<string>) {
    writeFileSync(this.seededPath(), [...names].sort().join("\n") + (names.size ? "\n" : ""));
  }

  async ensureDefaults() {
    const seeded = this.seeded();
    for (const d of pendingDefaults(this.saved().packages, [...seeded])) {
      try {
        await this.install(d.spec);
        seeded.add(d.name);
      } catch (e) {
        console.error(`default pi package ${d.spec} not installed:`, e instanceof Error ? e.message : e);
      }
    }
    for (const d of DEFAULT_PI_PACKAGES) {
      if (this.saved().packages.some((p) => packageMatches(p, d))) seeded.add(d.name);
    }
    this.writeSeeded(seeded);
  }

  async install(spec: string) {
    const raw = spec.trim().replace(/^npm:/, "").replace(/\/+$/, "");
    const git = isGitSpec(raw);
    const named = git ? undefined : packageName(raw);
    if (!git && !NPM_NAME.test(named ?? "")) throw new Error(`not an npm package or GitHub repo: ${spec}`);
    if (!existsSync(join(this.dir, "package.json"))) writeFileSync(join(this.dir, "package.json"), JSON.stringify({ name: "switchboard-pi-packages", private: true }, null, 2));
    const before = Object.keys(this.dependencies());
    await this.npm(["install", "--no-audit", "--no-fund", "--loglevel=error", raw, ...HOST_PACKAGES.filter((h) => !existsSync(join(this.dir, "node_modules", h)))]);
    const name = named ?? dependencyAdded(before, this.dependencies(), raw, HOST_PACKAGES);
    if (!name) throw new Error(`could not tell which package ${raw} installed`);
    const s = this.saved();
    s.packages = [...s.packages.filter((p) => p.name !== name), { name, spec: raw }];
    this.save(s);
    return name;
  }

  async remove(name: string) {
    const s = this.saved();
    s.packages = s.packages.filter((p) => p.name !== name);
    this.save(s);
    const src = join(this.dir, "src");
    for (const old of existsSync(src) ? readdirSync(src).filter((d) => d.startsWith(`${groupFor(name)}~`)) : []) rmSync(join(src, old), { recursive: true, force: true });
    await this.npm(["uninstall", "--no-audit", "--no-fund", "--loglevel=error", name]).catch(() => {});
  }

  async loadAll() {
    this.loaded = [];
    for (const p of this.saved().packages) this.loaded.push(await this.load(p.name, p.spec));
    return this.loaded;
  }

  private entries(root: string, pkg: { pi?: { extensions?: string[] }; main?: string }) {
    const fromList = (list: string[]) =>
      list.flatMap((rel) => {
        const p = resolve(root, rel.replace(/\/\*.*$/, ""));
        return existsSync(p) && statSync(p).isDirectory() ? scan(p) : existsSync(p) ? [p] : [];
      });
    const scan = (dir: string) =>
      readdirSync(dir).flatMap((f) => {
        const p = join(dir, f);
        if (statSync(p).isDirectory()) return ["index.ts", "index.js"].map((i) => join(p, i)).filter(existsSync).slice(0, 1);
        return /\.(ts|js|mjs)$/.test(f) && !f.endsWith(".d.ts") && !/\.test\./.test(f) ? [p] : [];
      });
    if (pkg.pi?.extensions?.length) return fromList(pkg.pi.extensions);
    if (existsSync(join(root, "extensions"))) return scan(join(root, "extensions"));
    return pkg.main ? fromList([pkg.main]) : [];
  }

  private copySkills(root: string, pkg: { pi?: { skills?: string[] } }) {
    const dirs = (pkg.pi?.skills ?? ["skills"]).map((d) => resolve(root, d.replace(/\/\*.*$/, ""))).filter((d) => existsSync(d) && statSync(d).isDirectory());
    const names: string[] = [];
    for (const dir of dirs) {
      const candidates = existsSync(join(dir, "SKILL.md")) ? [dir] : readdirSync(dir).map((f) => join(dir, f)).filter((p) => existsSync(join(p, "SKILL.md")));
      for (const c of candidates) {
        const name = c.split(/[\\/]/).pop()!;
        const dest = join(this.skillsDir, name);
        if (existsSync(dest) && !existsSync(join(dest, ".from-pi-package"))) continue;
        cpSync(c, dest, { recursive: true });
        writeFileSync(join(dest, ".from-pi-package"), "");
        names.push(name);
      }
    }
    return names;
  }

  private async load(name: string, spec: string): Promise<LoadedPackage> {
    const group = groupFor(name);
    const out: LoadedPackage = { name, spec, group, tools: [], skills: [], providers: [], commands: [], hooks: [], ignored: [] };
    const installed = join(this.dir, "node_modules", name);
    if (!existsSync(installed)) return { ...out, error: "not installed" };
    const src = join(this.dir, "src");
    mkdirSync(src, { recursive: true });
    for (const old of readdirSync(src).filter((d) => d === group || d.startsWith(`${group}~`))) {
      try {
        rmSync(join(src, old), { recursive: true, force: true });
      } catch {}
    }
    const root = join(src, `${group}~${Date.now().toString(36)}`);
    try {
      cpSync(installed, root, { recursive: true, filter: (src) => !/[\\/]node_modules([\\/]|$)/.test(src.slice(installed.length)) });
      if (existsSync(join(installed, "node_modules"))) cpSync(join(installed, "node_modules"), join(root, "node_modules"), { recursive: true });
      const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
      out.skills = this.copySkills(root, pkg);
      const shim = this.shim(out);
      for (const file of this.entries(root, pkg)) {
        const mod = (await import(pathToFileURL(file).href)) as { default?: (pi: unknown) => unknown; createMcpAdapter?: (opts: { config: SwitchboardMcpConfig }) => (pi: unknown) => unknown };
        if (name === "pi-mcp-adapter" && this.mcpConfig && typeof mod.createMcpAdapter === "function") {
          await mod.createMcpAdapter({ config: this.mcpConfig })(shim);
          continue;
        }
        if (typeof mod.default !== "function") continue;
        await mod.default(shim);
      }
    } catch (e) {
      out.error = e instanceof Error ? e.message : String(e);
    }
    return out;
  }

  private shim(out: LoadedPackage) {
    const ignore = (what: string) => () => {
      if (!out.ignored.includes(what)) out.ignored.push(what);
      return () => {};
    };
    const api: Record<string, unknown> = {
      registerTool: (def: PiToolDef) => out.tools.push(def),
      registerProvider: (provider: PiProviderDef) => {
        if (provider?.id) out.providers.push(provider);
      },
      registerCommand: (name: string, def: { description?: string; handler?: PiCommand["handler"] } | PiCommand["handler"] = {}) => {
        const handler = typeof def === "function" ? def : def?.handler;
        if (typeof name !== "string" || !name.trim()) return;
        out.commands.push({ name: name.replace(/^\//, ""), description: typeof def === "function" ? "" : def?.description || "", handler: handler ?? (() => "") });
      },
      on: (event: string, handler?: PiHook["handler"]) => {
        if (typeof event === "string" && typeof handler === "function") out.hooks.push({ event, handler });
        return () => {};
      },
      events: { on: () => () => {}, emit: () => {}, off: () => {} },
      getFlag: () => undefined,
      getActiveTools: () => out.tools.map((t) => t.name),
      getAllTools: () => out.tools.map((t) => ({ name: t.name })),
      getSettings: () => ({}),
      getCommands: () => [],
      getThinkingLevel: () => "off",
      exec: (command: string, args: string[] = [], opts: { cwd?: string } = {}) =>
        new Promise((ok) => {
          const child = spawn(command, args, { cwd: opts.cwd, shell: process.platform === "win32" });
          let stdout = "";
          let stderr = "";
          child.stdout?.on("data", (c) => (stdout += String(c)));
          child.stderr?.on("data", (c) => (stderr += String(c)));
          child.on("close", (code) => ok({ stdout, stderr, code: code ?? 0, killed: false }));
          child.on("error", (e) => ok({ stdout, stderr: String(e), code: 1, killed: false }));
        }),
    };
    return new Proxy(api, {
      get: (t, k) => {
        if (typeof k === "string" && PROBE_ABSENT.has(k)) return undefined;
        if (k in t) return t[k as string];
        return typeof k === "string" ? ignore(k) : undefined;
      },
    });
  }
}

export function toolContext(cwd: string) {
  const ui = new Proxy({}, { get: () => () => undefined });
  const base: Record<string, unknown> = { cwd, hasUI: false, ui, signal: undefined, isIdle: () => false, abort: () => {} };
  return new Proxy(base, { get: (t, k) => (k in t ? t[k as string] : undefined) });
}
