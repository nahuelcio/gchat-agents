import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createInterface } from "node:readline";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { tmpdir } from "node:os";
import { acceptWebSockets, createHost } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { WebSocketServer } from "ws";
import { envApiKeyAuth, Type, type Api, type Model, type ProviderStreams } from "@earendil-works/pi-ai";
import { createModels, createProvider, type MutableModels } from "@earendil-works/pi-ai/models";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { toolCallStreamFixer } from "./tool-call-stream.ts";
import { PiPackages, toolContext } from "./pi-packages.ts";
import { insights } from "./insights.ts";
import { engramDigest } from "./engram.ts";
import { ThreadView, type ThreadViewPrincipal } from "./thread-view.ts";
import { CodemodeSandbox } from "@earendil-works/pi-codemode";
import { createCodemodeExtension } from "@earendil-works/pi-durable/codemode";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { AssistantEntry, createRegistry, defineDoc, defineExtension, defineTool, Harness, type Conversation } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { CodingTools } from "@earendil-works/pi-durable/tools";

const dataDir = process.env.DATA_DIR ?? "./data";
const port = Number(process.env.PI_PORT ?? 8090);
const adminUrl = (process.env.SWITCHBOARD_ADMIN_URL ?? "http://127.0.0.1:8081").replace(/\/$/, "");
const defaultModel = process.env.PI_MODEL ?? "";
const threadsFile = join(dataDir, "harness-threads.json");
const SECRET = /KEY|TOKEN|SECRET|PASSWORD|SERVICE_ACCOUNT|CREDENTIAL/i;

const localBin = join(process.cwd(), "node_modules", ".bin");
if (existsSync(localBin)) {
  const sep = process.platform === "win32" ? ";" : ":";
  process.env.PATH = `${localBin}${sep}${process.env.PATH ?? ""}`;
}

function loadAdoPat() {
  if (process.env.AZURE_DEVOPS_PAT?.trim()) return;
  try {
    const file = join(dataDir, "ado.json");
    if (!existsSync(file)) return;
    const stored = JSON.parse(readFileSync(file, "utf8")) as { pat?: string };
    if (stored.pat?.trim()) process.env.AZURE_DEVOPS_PAT = stored.pat.trim();
  } catch {}
}
loadAdoPat();

mkdirSync(dataDir, { recursive: true });
const ThreadIndex = defineDoc<{ threads: Record<string, string>; requests: Record<string, string> }>({
  kind: "switchboard.threads",
  version: 1,
  scope: "session",
  initial: () => ({ threads: {}, requests: {} }),
});
const saved: { threads: Record<string, string>; requests: Record<string, string> } = { threads: {}, requests: {} };
const threads = saved.threads;

function lastUserText(context: { messages?: { role: string; content: unknown }[] }): string {
  const msg = [...(context.messages ?? [])].reverse().find((m) => m.role === "user" || m.role === "toolResult");
  if (!msg) return "";
  if (typeof msg.content === "string") return msg.content;
  return (msg.content as { type: string; text?: string }[]).map((c) => c.text ?? "").join("");
}

type CustomProviderConfig = {
  id: string;
  name?: string;
  baseUrl: string;
  models: string[];
  apiKeyEnv?: string;
  contextWindow?: number;
  maxTokens?: number;
};

const customProviderIds = new Set<string>();
let modelsRef: MutableModels;

function loadCustomProviders(): CustomProviderConfig[] {
  const file = join(dataDir, "pi-custom-providers.json");
  if (!existsSync(file)) return [];
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as CustomProviderConfig[];
    return Array.isArray(raw) ? raw.filter((p) => p?.id && p?.baseUrl && Array.isArray(p.models)) : [];
  } catch (err) {
    console.error("pi-custom-providers.json unreadable:", err instanceof Error ? err.message : err);
    return [];
  }
}

function customEnv(id: string, explicit?: string) {
  if (explicit) return explicit;
  return `PI_CUSTOM_${id.replace(/-/g, "_").toUpperCase()}_API_KEY`;
}

function buildCustomProvider(cfg: CustomProviderConfig) {
  const contextWindow = cfg.contextWindow || 128_000;
  const maxTokens = cfg.maxTokens || 32_000;
  const models = cfg.models
    .map((id) => id.trim())
    .filter(Boolean)
    .map(
      (id): Model<"openai-completions"> => ({
        id,
        name: id,
        api: "openai-completions",
        provider: cfg.id,
        baseUrl: cfg.baseUrl,
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow,
        maxTokens,
        compat: { sendSessionAffinityHeaders: true, sessionAffinityFormat: "openrouter" },
      }),
    );
  const envVar = customEnv(cfg.id, cfg.apiKeyEnv);
  const hasKey = !!(process.env[envVar] || "").trim();
  return createProvider({
    id: cfg.id,
    name: cfg.name || cfg.id,
    baseUrl: cfg.baseUrl,
    auth: hasKey
      ? { apiKey: envApiKeyAuth(cfg.name || cfg.id, [envVar]) }
      : { apiKey: { name: cfg.name || cfg.id, resolve: async () => ({ auth: {} }) } },
    models,
    api: lenientToolCalls(openAICompletionsApi()),
  });
}
function lenientToolCalls(api: ProviderStreams): ProviderStreams {
  const withFix = <O extends { onProviderStreamEvent?: (data: unknown, model: Model<Api>) => void | Promise<void> }>(o?: O) => {
    const fix = toolCallStreamFixer();
    return { ...o, onProviderStreamEvent: (data: unknown, model: Model<Api>) => (fix(data), o?.onProviderStreamEvent?.(data, model)) } as O;
  };
  return { ...api, stream: (m, c, o) => api.stream(m, c, withFix(o)), streamSimple: (m, c, o) => api.streamSimple(m, c, withFix(o)) };
}

function applyCustomProviders(m: MutableModels) {
  loadKeys();
  const next = loadCustomProviders();
  const nextIds = new Set(next.map((p) => p.id));
  for (const id of customProviderIds) {
    if (!nextIds.has(id)) m.deleteProvider(id);
  }
  customProviderIds.clear();
  for (const cfg of next) {
    try {
      m.setProvider(buildCustomProvider(cfg));
      customProviderIds.add(cfg.id);
    } catch (err) {
      console.error(`custom provider ${cfg.id} skipped:`, err instanceof Error ? err.message : err);
    }
  }
}

function models(): MutableModels {
  if (process.env.PI_FAUX !== "1") {
    modelsRef = builtinModels();
    applyCustomProviders(modelsRef);
    return modelsRef;
  }
  const faux = fauxProvider({ provider: "faux", models: [{ id: "echo", contextWindow: 200_000 }] });
  const respond = (context: { messages?: { role: string; content: unknown }[] }): ReturnType<typeof fauxAssistantMessage> | Promise<ReturnType<typeof fauxAssistantMessage>> => {
    const last = [...(context.messages ?? [])].reverse()[0];
    const text = lastUserText(context);
    if (last?.role === "toolResult") return fauxAssistantMessage(`Tool said: ${text.slice(0, 200)}`);
    const read = text.match(/READ:(\S+)/);
    if (read) return fauxAssistantMessage([fauxToolCall("read", { path: read[1]! })], { stopReason: "toolUse" });
    const sleep = text.match(/SLEEP:(\d+)/);
    if (sleep) return new Promise((ok) => setTimeout(() => ok(fauxAssistantMessage(`Slept ${sleep[1]}s`)), Number(sleep[1]) * 1000));
    const bash = text.match(/BASH:(.+)$/m);
    if (bash) return fauxAssistantMessage([fauxToolCall("bash", { command: bash[1]! })], { stopReason: "toolUse" });
    return fauxAssistantMessage(`Echo: ${text.split("\n---\n").pop()?.trim()}`);
  };
  faux.setResponses(Array.from({ length: 10_000 }, () => respond));
  modelsRef = createModels();
  modelsRef.setProvider(faux.provider);
  applyCustomProviders(modelsRef);
  return modelsRef;
}

const SAFE = new Set(["create_xlsx", "list_spreadsheets", "list_agents", "list_repos", "thread_status", "list_schedules"]);

type McpTool = { name: string; description?: string; inputSchema?: Record<string, unknown>; _meta?: { group?: string } };

class McpClient {
  private child: ChildProcessByStdio<Writable, Readable, null>;
  private next = 1;
  private pending = new Map<number, (msg: { result?: unknown; error?: { message?: string } }) => void>();
  constructor(command: string, args: string[]) {
    this.child = spawn(command, args, { env: { ...process.env, SWITCHBOARD_ADMIN_URL: adminUrl }, stdio: ["pipe", "pipe", "ignore"] });
    createInterface({ input: this.child.stdout }).on("line", (line) => {
      try {
        const msg = JSON.parse(line) as { id?: number };
        if (typeof msg.id === "number") this.pending.get(msg.id)?.(msg as never);
      } catch {}
    });
  }
  request(method: string, params: unknown): Promise<unknown> {
    const id = this.next++;
    return new Promise((ok, fail) => {
      this.pending.set(id, (msg) => {
        this.pending.delete(id);
        msg.error ? fail(new Error(msg.error.message ?? "MCP error")) : ok(msg.result);
      });
      this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }
  close() {
    this.child.kill();
  }
}

let mcp: McpClient | undefined;
const DIRECT_GROUPS = new Set(["skills"]);
const modelOnly = <T extends object>(tool: T) => ({ ...tool, callers: ["model"] as const });
const RISKY = [
  /\brm\s+-[a-z]*[rf]/i,
  /\bRemove-Item\b[^\n]*-(Recurse|Force)/i,
  /\b(del|erase)\s+\/[sq]/i,
  /\brd\s+\/s/i,
  /\bgit\s+push\b/i,
  /\bgit\s+reset\s+--hard/i,
  /\bgit\s+clean\s+-[a-z]*f/i,
  /\bgit\s+branch\s+-D\b/,
  /\bgit\s+(checkout|restore)\s+(--\s|\.)/i,
  /\bgit\s+rebase\b/i,
  /\b(drop|truncate)\s+(table|database|schema)\b/i,
  /\bdelete\s+from\b/i,
  /\b(npm|pnpm|yarn|cargo|dotnet\s+nuget)\s+publish\b/i,
  /\bkubectl\s+(delete|apply|scale|rollout\s+restart|drain)\b/i,
  /\bhelm\s+(install|upgrade|uninstall|rollback)\b/i,
  /\bterraform\s+(apply|destroy)\b/i,
  /\bdocker\s+(rm|rmi|system\s+prune|volume\s+rm)\b/i,
  /\bgh\s+(pr\s+merge|release\s+create|repo\s+delete|workflow\s+run)\b/i,
  /\baz\s+[a-z-]+\s+(delete|create|update)\b/i,
  /\b(shutdown|reboot|mkfs|format\s+[a-z]:)\b/i,
  /\bdd\s+if=/i,
  /\b(curl|wget|irm|iwr)\b[^|\n]*\|\s*(sh|bash|iex|pwsh|powershell)\b/i,
  /\bchmod\s+-R\b/i,
  /\bStop-Process\b|\btaskkill\b|\bkill\s+-9\b/i,
];
const RISKY_TOOL = /(^|__)(delete|remove|drop|merge|deploy|destroy|apply|publish|send)_?/i;

function gateFor(name: string, args: Record<string, unknown>): { kind: string; detail: string } | undefined {
  if (name === "bash" || name === "powershell") {
    const command = String(args.command ?? "");
    return { kind: RISKY.some((r) => r.test(command)) ? "risky" : "shell", detail: command };
  }
  if (name === "write" || name === "edit") return { kind: "write", detail: `${name} ${String(args.path ?? "")}` };
  if (name.includes("__") && RISKY_TOOL.test(name.split("__").pop() ?? "")) return { kind: "risky", detail: `${name} ${JSON.stringify(args).slice(0, 1200)}` };
  return undefined;
}

const cwdOf: Record<string, string> = {};
const WRITES = /(^|[^<>=!])>{1,2}(?!=)|\b(cp|mv|rm|rmdir|mkdir|touch|tee|ln|chmod|chown|install|unzip|tar\s+-?x)\b|\bsed\s+-i|\bgit\b[^|;&\n]*\s(commit|checkout|switch|reset|clean|merge|rebase|pull|push|stash|apply|am|cherry-pick|restore|rm|mv|init|clone)\b|\b(npm|pnpm|yarn|bun)\s+(i|install|add|remove|uninstall|ci|update)\b|\bcargo\s+(add|remove|install|build|update)\b|\bdotnet\s+(add|remove|new|build|restore)\b|\bpip\s+install\b|\b(Set-Content|Add-Content|Out-File|New-Item|Copy-Item|Move-Item|Remove-Item|Rename-Item|Expand-Archive)\b|\b(del|erase|copy|move|ren|md|mkdir|rd|xcopy|robocopy)\s/i;
const ABS_PATH = /(?:^|[\s"'=(])((?:[A-Za-z]:[\\/]|\/(?:[a-z]\/|home\/|Users\/|mnt\/|srv\/|opt\/|var\/|etc\/))[^\s"'|;&<>()]*)/g;

function inside(root: string, target: string) {
  const rel = relative(resolve(root), resolve(root, target));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function msysToWin(p: string) {
  const m = /^\/([a-z])\/(.*)$/i.exec(p);
  return process.platform === "win32" && m ? `${m[1]}:/${m[2]}` : p;
}

function outsidePaths(cwd: string, name: string, args: Record<string, unknown>): string[] {
  const allowed = [cwd, tmpdir(), resolve(dataDir, "media")];
  const ok = (p: string) => allowed.some((root) => inside(root, msysToWin(p)));
  if (name === "write" || name === "edit") {
    const path = String(args.path ?? "");
    return path && !ok(path) ? [resolve(cwd, path)] : [];
  }
  if (name === "bash" || name === "powershell") {
    const command = String(args.command ?? "");
    if (!WRITES.test(command)) return [];
    return [...command.matchAll(ABS_PATH)].map((m) => m[1] ?? "").filter((p) => p && !ok(p));
  }
  return [];
}

function touch(conversationId: string, name: string, args: Record<string, unknown>) {
  if (!["bash", "powershell", "write", "edit", "read"].includes(name)) return;
  const detail = name === "bash" || name === "powershell" ? String(args.command ?? "") : String(args.path ?? "");
  try {
    appendFileSync(join(dataDir, "touches.jsonl"), JSON.stringify({ at: new Date().toISOString(), thread: threads[conversationId] ?? "", tool: name, detail: detail.slice(0, 500), cwd: cwdOf[conversationId] ?? "" }) + "\n");
  } catch {}
}

async function approved(conversationId: string, name: string, args: Record<string, unknown>, destructive = false) {
  const admin = process.env.SWITCHBOARD_ADMIN_URL;
  touch(conversationId, name, args);
  const cwd = cwdOf[conversationId];
  const outside = cwd ? outsidePaths(cwd, name, args) : [];
  const need = outside.length
    ? { kind: "outside", detail: `${gateFor(name, args)?.detail ?? name}\n(outside ${cwd}: ${outside.slice(0, 3).join(", ")})` }
    : destructive
      ? { kind: "risky", detail: `${name} ${JSON.stringify(args).slice(0, 1200)}` }
      : gateFor(name, args);
  if (!admin || !need || need.kind === "shell") return;
  const res = await fetch(`${admin}/api/gate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ thread: threads[conversationId] ?? "", tool: name, ...need }),
  });
  const out = (await res.json().catch(() => ({}))) as { approve?: boolean };
  if (!out.approve) throw new Error("The user denied this action or did not answer in time. Do not retry it; say what you wanted to do and why, and ask how to proceed.");
}

type Gateable = { name: string; execute: (args: never, api: never, context: never) => unknown };
const gated = <T extends Gateable>(tool: T): T => ({
  ...tool,
  execute: async (args: never, api: never, context: never) => {
    await approved(String((api as { conversationId: string }).conversationId), tool.name, args as Record<string, unknown>);
    return tool.execute(args, api, context);
  },
});
const coding = { ...CodingTools, tools: (CodingTools.tools ?? []).map((t) => modelOnly(gated(t as never) as typeof t)) };
let mcpTools: { group: string; tool: ReturnType<typeof defineTool> }[] = [];
const codemode = createCodemodeExtension({ sandbox: new CodemodeSandbox({ timeoutMs: 120_000 }), models: false });

async function loadMcp() {
  mcp?.close();
  const bin = process.env.SWITCHBOARD_BIN;
  if (!bin) return;
  mcp = new McpClient(bin, ["mcp"]);
  await mcp.request("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "pi-harness", version: "1" } });
  const listed = (await mcp.request("tools/list", {})) as { tools: McpTool[] };
  const client = mcp;
  mcpTools = listed.tools.map((t) => {
    const schema = structuredClone(t.inputSchema ?? { type: "object", properties: {} }) as { properties?: Record<string, unknown>; required?: string[] };
    delete schema.properties?.thread;
    schema.required = schema.required?.filter((r) => r !== "thread");
    const tool = defineTool({
      name: t.name,
      description: t.description ?? t.name,
      parameters: Type.Unsafe<Record<string, unknown>>(schema),
      ...(SAFE.has(t.name) ? { replay: "safe" as const } : {}),
      callers: DIRECT_GROUPS.has(t._meta?.group ?? "") ? (["model"] as const) : (["tools"] as const),
      execute: async (args, api) => {
        const thread = threads[api.conversationId] ?? "";
        await approved(String(api.conversationId), t.name, args as Record<string, unknown>);
        const extra = SAFE.has(t.name) && t.name === "create_xlsx" ? { taskId: `pi:${api.taskId}` } : {};
        const result = (await client.request("tools/call", { name: t.name, arguments: { ...args, ...extra, thread } })) as { content?: { type: string; text?: string }[] };
        return { output: [{ type: "text", text: (result.content ?? []).map((c) => c.text ?? "").join("\n") || "(no output)" }] };
      },
    });
    return { group: t._meta?.group ?? "switchboard", tool };
  });
  registry.install(defineExtension({ name: "mcp", tools: mcpTools.map((t) => t.tool) }));
}

const piPackages = new PiPackages(dataDir);
let piTools: { group: string; tool: ReturnType<typeof defineTool> }[] = [];

async function loadPiPackages() {
  const loaded = await piPackages.loadAll();
  piTools = loaded.flatMap((pkg) =>
    pkg.tools.map((def) => {
      const tool = defineTool({
        name: def.name,
        description: def.description,
        parameters: def.parameters as never,
        callers: ["model"] as const,
        execute: async (args, api, context) => {
          const conversationId = String(api.conversationId);
          await approved(conversationId, def.name, args as Record<string, unknown>, Boolean(def.annotations?.destructiveHint));
          const result = await def.execute(`pi:${api.taskId}`, args, (context as { abortSignal?: AbortSignal } | undefined)?.abortSignal, undefined, toolContext(cwdOf[conversationId] ?? process.cwd()));
          const output = (result.content ?? []).map((c) =>
            c.type === "image" && c.data && c.mimeType ? { type: "image" as const, data: c.data, mimeType: c.mimeType } : { type: "text" as const, text: c.text ?? JSON.stringify(c) },
          );
          if (result.isError) throw new Error(output.map((o) => ("text" in o ? o.text : "")).join("\n") || "tool failed");
          return { output: output.length ? output : [{ type: "text" as const, text: "(no output)" }] };
        },
      });
      return { group: pkg.group, tool };
    }),
  );
  registry.install(defineExtension({ name: "pi-packages", tools: piTools.map((t) => t.tool) }));
  return loaded;
}

function packageSummary() {
  return piPackages.loaded.map((p) => ({ name: p.name, spec: p.spec, group: p.group, tools: p.tools.map((t) => t.name), skills: p.skills, ignored: p.ignored, error: p.error }));
}

function toolsFor(groups?: string[] | null) {
  const all = !groups || groups.length === 0;
  const codingTools = all || groups.includes("coding") ? coding.tools : [];
  const mcp = mcpTools.filter((t) => all || groups.includes(t.group)).map((t) => t.tool);
  const pi = piTools.filter((t) => all || groups.includes(t.group)).map((t) => t.tool);
  return [...codingTools, ...mcp, ...pi, ...(codemode.tools ?? [])];
}

const registry = createRegistry();
registry.install(coding);
registry.install(codemode);
await loadMcp().catch((e) => console.error("MCP tools unavailable:", e instanceof Error ? e.message : e));
await loadPiPackages().catch((e) => console.error("pi packages unavailable:", e instanceof Error ? e.message : e));

const harness = await Harness.open(
  await openNodeSqliteStorage(join(dataDir, "harness.sqlite")),
  {
    models: models(),
    registry,
    env: (target) => {
      loadAdoPat();
      const shellEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !SECRET.test(k)));
      return new NodeExecutionEnv({ cwd: target.cwd ?? dataDir, shellEnv });
    },
    settings: { compaction: { reserveTokens: 16384, backgroundTokens: 32768 }, retry: { maxRetries: 3 }, stream: { timeoutMs: 180_000 } },
  },
  ctx,
);
await loadThreadIndex();
harness.resume();

async function loadThreadIndex() {
  let legacy: typeof saved | undefined;
  try {
    if (existsSync(threadsFile)) legacy = JSON.parse(readFileSync(threadsFile, "utf8"));
  } catch (err) {
    console.error("harness-threads.json unreadable, skipping its import:", err instanceof Error ? err.message : err);
  }
  if (legacy) {
    await harness.commit(async (tx) => {
      const doc = await tx.doc(ThreadIndex);
      Object.assign(doc.threads, legacy.threads ?? {});
      Object.assign(doc.requests, legacy.requests ?? {});
    }, ctx);
    renameSync(threadsFile, `${threadsFile}.imported`);
  }
  const stored = await harness.snapshot(ThreadIndex, ctx);
  Object.assign(saved.threads, stored?.threads ?? {});
  Object.assign(saved.requests, stored?.requests ?? {});
}

async function index(tx: Parameters<Parameters<typeof harness.commit>[0]>[0], conversationId: string, threadKey: string, requestId: string) {
  const doc = await tx.doc(ThreadIndex);
  doc.threads[conversationId] = threadKey;
  doc.requests[requestId] = conversationId;
}

function remember(conversationId: string, threadKey: string, requestId: string) {
  threads[conversationId] = threadKey;
  saved.requests[requestId] = conversationId;
}

function modelRef(spec?: string) {
  const s = spec || defaultModel || (process.env.PI_FAUX === "1" ? "faux/echo" : "");
  const i = s.indexOf("/");
  return i > 0 ? { provider: s.slice(0, i), modelId: s.slice(i + 1) } : undefined;
}

type AssistantModel = {
  content?: { type: string; text?: string }[];
  usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
};

type UsageTotals = { cost: { total: number }; input?: number; output?: number; cacheRead?: number; cacheWrite?: number };

async function conversationTotals(conv: Conversation): Promise<{ costUsd: number; tokensIn: number; tokensOut: number }> {
  const view = await conv.viewState(ctx);
  try {
    const usage = view.value.docs["pi.usage"] as { models?: Record<string, UsageTotals>; tools?: Record<string, UsageTotals> } | undefined;
    const all = [...Object.values(usage?.models ?? {}), ...Object.values(usage?.tools ?? {})];
    return {
      costUsd: all.reduce((sum, t) => sum + t.cost.total, 0),
      tokensIn: all.reduce((sum, t) => sum + (t.input ?? 0) + (t.cacheRead ?? 0) + (t.cacheWrite ?? 0), 0),
      tokensOut: all.reduce((sum, t) => sum + (t.output ?? 0), 0),
    };
  } finally {
    view.dispose();
  }
}

async function commitAnswer(conv: Conversation, answer: unknown): Promise<{ reply: string; usage?: { contextTokens: number; contextWindow?: number; costUsd: number; tokensIn: number; tokensOut: number } }> {
  const entry = await conv.commit((tx) => tx.entry(AssistantEntry, answer as never), ctx);
  const msg = (entry?.model?.[0] as AssistantModel | undefined) ?? {};
  const content = msg.content ?? [];
  const reply = content.filter((c) => c.type === "text").map((c) => c.text ?? "").join("").trim();
  const u = msg.usage;
  const contextTokens = (u?.input ?? 0) + (u?.cacheRead ?? 0) + (u?.cacheWrite ?? 0) + (u?.output ?? 0);
  if (contextTokens <= 0) return { reply };
  let contextWindow: number | undefined;
  try {
    const agent = await conv.agent(ctx);
    const ref = agent.model;
    if (ref) {
      const model = modelsRef.getModel(ref.provider, ref.modelId);
      if (model?.contextWindow) contextWindow = model.contextWindow;
    }
  } catch {}
  return { reply, usage: { contextTokens, contextWindow, ...(await conversationTotals(conv)) } };
}

type SubmitBody = {
  conversationId?: string;
  threadKey: string;
  requestId: string;
  text: string;
  cwd?: string;
  model?: string;
  mcps?: string[] | null;
  instructions?: string | null;
};

function loadKeys() {
  const file = join(dataDir, "pi-keys.json");
  if (!existsSync(file)) return;
  for (const [name, value] of Object.entries(JSON.parse(readFileSync(file, "utf8")) as Record<string, string>)) {
    if (value) process.env[name] = value;
  }
  loadAdoPat();
}

const submissions = new Map<string, Awaited<ReturnType<Conversation["submit"]>>>();

const ATTACHED = /^\[Attached (image\/(?:png|jpe?g|gif|webp)) .*?: (.+)\]$/gm;
const MAX_IMAGE = 5 * 1024 * 1024;

function inputContent(text: string) {
  const images = [...text.matchAll(ATTACHED)].flatMap(([, mimeType = "", path = ""]) => {
    try {
      const bytes = readFileSync(path.trim());
      return bytes.length <= MAX_IMAGE ? [{ type: "image" as const, data: bytes.toString("base64"), mimeType: mimeType === "image/jpg" ? "image/jpeg" : mimeType }] : [];
    } catch {
      return [];
    }
  });
  return images.length ? [{ type: "text" as const, text }, ...images] : text;
}

async function admit(body: SubmitBody) {
  loadKeys();
  const known = saved.requests[body.requestId];
  if (!known && !body.text?.trim()) throw new Error("empty input for a new request");
  let conv = known ? await harness.conversation(known as never, ctx) : undefined;
  if (!conv && body.conversationId) conv = await harness.conversation(body.conversationId as never, ctx);
  if (conv) {
    const id = String(conv.id);
    if (!known) await conv.commit((tx) => index(tx, id, body.threadKey, body.requestId), ctx);
  } else {
    conv = await harness.createConversation({ ownership: { kind: "ownerless" }, init: (tx, id) => index(tx, String(id), body.threadKey, body.requestId) }, ctx);
  }
  remember(String(conv.id), body.threadKey, body.requestId);
  if (body.cwd) cwdOf[String(conv.id)] = body.cwd;
  if (!known) {
    await conv.configure({ model: modelRef(body.model) ?? null, cwd: body.cwd ?? null, tools: toolsFor(body.mcps), instructions: body.instructions || null }, ctx);
  }
  const submission = await conv.submit({ type: "input", content: body.text ? inputContent(body.text) : "(resumed)", requestId: body.requestId }, ctx);
  submissions.set(body.requestId, submission);
  return { conversationId: String(conv.id) };
}
const joins = new Map<string, string[]>();

async function runInputs(conv: Conversation) {
  const view = await conv.viewState(ctx);
  try {
    return (view.value.docs["pi.live"] as { run?: { inputs: string[] } } | undefined)?.run?.inputs;
  } finally {
    view.dispose();
  }
}
async function steer(body: { conversationId: string; threadKey: string; requestId: string; text: string }) {
  const conv = await harness.conversation(body.conversationId as never, ctx);
  if (!conv || !body.text?.trim()) return { status: "idle" };
  const inputs = await runInputs(conv);
  if (!inputs?.length) return { status: "idle" };
  const id = String(conv.id);
  if (!saved.requests[body.requestId]) await conv.commit((tx) => index(tx, id, body.threadKey, body.requestId), ctx);
  remember(id, body.threadKey, body.requestId);
  joins.set(body.requestId, inputs);
  const submission = await conv.submit({ type: "input", content: inputContent(body.text), requestId: body.requestId, whenBusy: "steer" }, ctx);
  submissions.set(body.requestId, submission);
  return { status: "steered", conversationId: id };
}

async function joined(requestId: string, answer: string) {
  const inputs = joins.get(requestId);
  joins.delete(requestId);
  for (const input of inputs ?? []) {
    const record = await (await harness.submission(input as never, ctx))?.status(ctx);
    if (record?.status === "done" && String(record.answer) === answer) return true;
  }
  return false;
}

async function waitFor(requestId: string, ms: number) {
  const known = saved.requests[requestId];
  if (!known) return { status: "unknown" };
  const conv = await harness.conversation(known as never, ctx);
  if (!conv) return { status: "unknown" };
  let submission = submissions.get(requestId);
  if (!submission) {
    submission = await conv.submit({ type: "input", content: "(resumed)", requestId }, ctx);
    submissions.set(requestId, submission);
  }
  const settled = await Promise.race([submission.wait(ctx), new Promise<undefined>((ok) => setTimeout(() => ok(undefined), ms))]);
  if (!settled) return { status: "running", conversationId: known };
  submissions.delete(requestId);
  if (settled.status !== "done" || settled.type !== "input") {
    joins.delete(requestId);
    const { reason, detail } = settled as { reason?: unknown; detail?: unknown };
    const why = typeof detail === "string" ? detail : detail ? JSON.stringify(detail) : "";
    return { status: "unanswered", conversationId: known, error: [reason ?? "unanswered", why].filter(Boolean).join(": ") };
  }
  if (await joined(requestId, String(settled.answer))) return { status: "joined", conversationId: known };
  const { reply, usage } = await commitAnswer(conv, settled.answer);
  return { status: "done", conversationId: known, reply, usage };
}

async function compact(body: { conversationId: string; instructions?: string }) {
  const conv = await harness.conversation(body.conversationId as never, ctx);
  if (!conv) return { status: "unknown" };
  const task = await conv.compact(body.instructions || undefined, ctx);
  const { outcome } = (await harness.waitForTask(task, ctx)).state as { outcome: { status: string; result?: { submissionId?: string }; error?: unknown } };
  if (outcome.status !== "completed") return { status: "failed", error: String(outcome.error ?? outcome.status) };
  const placed = outcome.result?.submissionId;
  if (placed === undefined) return { status: "nothing" };
  const settled = await (await harness.submission(placed as never, ctx))?.wait(ctx);
  return { status: settled?.status === "done" ? "done" : "stale" };
}

async function reset(body: { conversationId: string; handoff?: string }) {
  const conv = await harness.conversation(body.conversationId as never, ctx);
  if (!conv) return { status: "unknown" };
  await conv.reset(body.handoff || undefined, ctx);
  return { status: "done" };
}

const read = (req: IncomingMessage) =>
  new Promise<string>((ok) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => ok(raw));
  });

const send = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};
const threadConversation = (thread: string) => Object.entries(threads).findLast(([, key]) => key === thread)?.[0];

const viewHost = createHost<ThreadViewPrincipal>({ name: "view", self: { thread: "" } });
viewHost.serve(ThreadView, (_input, principal, self) => {
  const view = self.resource("view", {
    version: 1,
    open: async ({ signal }) => {
      for (;;) {
        const id = threadConversation(principal.thread);
        const conv = id === undefined ? undefined : await harness.conversation(id as never, ctx);
        if (conv) return conv.viewState(ctx);
        if (signal.aborted) throw new Error(`no conversation for thread ${principal.thread}`);
        await new Promise((ok) => setTimeout(ok, 250));
      }
    },
    close: (state) => state.dispose(),
  });
  const mirror = self.state("view", Type.Any(), { init: () => view.value.value });
  self.on("mirror", view, (state) => state, (value, c) => mirror.replace(c, value));
  return { variant: "viewer", view: mirror };
});

const server = createServer(async (req, res) => {
  try {
    if (req.method === "GET" && req.url === "/health") return send(res, 200, { ok: true, faux: process.env.PI_FAUX === "1" });
    if (req.method === "POST" && req.url === "/submit") return send(res, 200, await admit(JSON.parse(await read(req)) as SubmitBody));
    if (req.method === "POST" && req.url === "/wait") {
      const { requestId, timeoutMs } = JSON.parse(await read(req)) as { requestId: string; timeoutMs?: number };
      return send(res, 200, await waitFor(requestId, Math.min(timeoutMs ?? 50_000, 50_000)));
    }
    if (req.method === "POST" && req.url === "/steer") return send(res, 200, await steer(JSON.parse(await read(req))));
    if (req.method === "POST" && req.url === "/compact") return send(res, 200, await compact(JSON.parse(await read(req))));
    if (req.method === "POST" && req.url === "/reset") return send(res, 200, await reset(JSON.parse(await read(req))));
    if (req.method === "POST" && req.url === "/reload") {
      await loadMcp();
      applyCustomProviders(modelsRef);
      return send(res, 200, {
        ok: true,
        tools: mcpTools.map((t) => t.tool.name),
        customProviders: [...customProviderIds],
      });
    }
    if (req.method === "GET" && req.url?.startsWith("/insights/engram")) return send(res, 200, engramDigest(60_000, new URL(req.url, "http://x").searchParams.get("project") || undefined));
    if (req.method === "POST" && req.url === "/insights") {
      const { days, labels, filter } = JSON.parse(await read(req)) as { days?: number; labels?: Record<string, { thread?: string; agent?: string; repos?: string[] }>; filter?: { agent?: string; repo?: string; thread?: string } };
      return send(res, 200, insights(join(dataDir, "harness.sqlite"), threads, labels ?? {}, days || 7, filter ?? {}));
    }
    if (req.method === "GET" && req.url === "/packages") return send(res, 200, packageSummary());
    if (req.method === "POST" && req.url === "/packages/install") {
      const { spec } = JSON.parse(await read(req)) as { spec?: string };
      if (!spec?.trim()) return send(res, 400, { error: "spec is required" });
      try {
        await piPackages.install(spec.trim());
      } catch (e) {
        return send(res, 400, { error: e instanceof Error ? e.message : String(e) });
      }
      await loadPiPackages();
      return send(res, 200, packageSummary());
    }
    if (req.method === "POST" && req.url === "/packages/remove") {
      const { name } = JSON.parse(await read(req)) as { name?: string };
      if (name) await piPackages.remove(name);
      await loadPiPackages();
      return send(res, 200, packageSummary());
    }
    if (req.method === "GET" && req.url === "/tools") return send(res, 200, mcpTools.map((t) => ({ name: t.tool.name, group: t.group })));
    if (req.method === "POST" && req.url === "/abort") {
      const { thread, conversationId } = JSON.parse(await read(req)) as { thread?: string; conversationId?: string };
      const ids = thread ? Object.entries(threads).filter(([, key]) => key === thread).map(([id]) => id) : conversationId ? [conversationId] : [];
      let aborted = 0;
      for (const id of ids) {
        try {
          const conv = await harness.conversation(id as never, ctx);
          if (conv) {
            await conv.abort(ctx);
            aborted += 1;
          }
        } catch (err) {
          console.error("abort failed:", err instanceof Error ? err.message : err);
        }
      }
      return send(res, 200, { ok: true, aborted });
    }
    send(res, 404, { error: "not found" });
  } catch (err) {
    if (res.headersSent) return void res.end();
    send(res, 500, { error: err instanceof Error ? err.message : String(err) });
  }
});
acceptWebSockets(new WebSocketServer({ server, path: "/view" }), viewHost, {
  principal: (request) => {
    const thread = new URL(request.url ?? "", "http://127.0.0.1").searchParams.get("thread") ?? "";
    return thread ? { thread } : undefined;
  },
});
server.listen(port, "127.0.0.1", () => console.log(`pi harness on 127.0.0.1:${port} (${dirname(join(dataDir, "harness.sqlite"))})`));

const shutdown = () => void viewHost.close().then(() => harness.close(ctx)).finally(() => process.exit(0));
for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, shutdown);
if (process.env.PI_PARENT_PIPE === "1") {
  process.stdin.resume();
  process.stdin.on("end", shutdown);
  process.stdin.on("close", shutdown);
}
