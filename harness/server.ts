import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createInterface } from "node:readline";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { envApiKeyAuth, Type, type Api, type Model, type ProviderStreams } from "@earendil-works/pi-ai";
import { createModels, createProvider, type MutableModels } from "@earendil-works/pi-ai/models";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { toolCallStreamFixer } from "./tool-call-stream.ts";
import { progressMapper, type ProgressItem } from "./progress.ts";
import { CodemodeSandbox } from "@earendil-works/pi-codemode";
import { createCodemodeExtension } from "@earendil-works/pi-durable/codemode";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { AssistantEntry, createRegistry, defineExtension, defineTool, Harness, watchEvents, type Conversation } from "@earendil-works/pi-durable";
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
  } catch {
    /* ignore */
  }
}
loadAdoPat();

mkdirSync(dataDir, { recursive: true });
function loadSaved(): { threads: Record<string, string>; requests: Record<string, string> } {
  try {
    if (existsSync(threadsFile)) return JSON.parse(readFileSync(threadsFile, "utf8"));
  } catch (err) {
    console.error("harness-threads.json unreadable, starting a new map:", err instanceof Error ? err.message : err);
  }
  return { threads: {}, requests: {} };
}
const saved = loadSaved();
const threads = saved.threads;
const remember = (conversationId: string, threadKey: string, requestId: string) => {
  threads[conversationId] = threadKey;
  saved.requests[requestId] = conversationId;
  const tmp = `${threadsFile}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(saved));
  renameSync(tmp, threadsFile);
};

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
        // Send pi-durable's per-conversation session id as `x-session-id`, so proxies like TokenBank group and pin sessions.
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

/** Custom OpenAI-compatible proxies (e.g. TokenBank) can garble tool call streams; repair each chunk before pi-ai reads it. */
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
    if (read) return fauxAssistantMessage([fauxToolCall("read", { path: read[1] })], { stopReason: "toolUse" });
    const sleep = text.match(/SLEEP:(\d+)/);
    if (sleep) return new Promise((ok) => setTimeout(() => ok(fauxAssistantMessage(`Slept ${sleep[1]}s`)), Number(sleep[1]) * 1000));
    const bash = text.match(/BASH:(.+)$/m);
    if (bash) return fauxAssistantMessage([fauxToolCall("bash", { command: bash[1] })], { stopReason: "toolUse" });
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
// Groups whose tools stay direct for the model; every other MCP tool is reachable only from code mode scripts (opencode-style).
const DIRECT_GROUPS = new Set(["skills"]);
// Direct tools are model-only, so they stay out of the code mode catalog and leave its budget to the deferred ones.
const modelOnly = <T extends object>(tool: T) => ({ ...tool, callers: ["model"] as const });
const coding = { ...CodingTools, tools: (CodingTools.tools ?? []).map(modelOnly) };
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
        const extra = SAFE.has(t.name) && t.name === "create_xlsx" ? { taskId: `pi:${api.taskId}` } : {};
        const result = (await client.request("tools/call", { name: t.name, arguments: { ...args, ...extra, thread } })) as { content?: { type: string; text?: string }[] };
        return { output: [{ type: "text", text: (result.content ?? []).map((c) => c.text ?? "").join("\n") || "(no output)" }] };
      },
    });
    return { group: t._meta?.group ?? "switchboard", tool };
  });
  registry.install(defineExtension({ name: "mcp", tools: mcpTools.map((t) => t.tool) }));
}

function toolsFor(groups?: string[] | null) {
  const all = !groups || groups.length === 0;
  const codingTools = all || groups.includes("coding") ? coding.tools : [];
  const mcp = mcpTools.filter((t) => all || groups.includes(t.group)).map((t) => t.tool);
  return [...codingTools, ...mcp, ...(codemode.tools ?? [])];
}

const registry = createRegistry();
registry.install(coding);
registry.install(codemode);
await loadMcp().catch((e) => console.error("MCP tools unavailable:", e instanceof Error ? e.message : e));

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
harness.resume();

function modelRef(spec?: string) {
  const s = spec || defaultModel || (process.env.PI_FAUX === "1" ? "faux/echo" : "");
  const i = s.indexOf("/");
  return i > 0 ? { provider: s.slice(0, i), modelId: s.slice(i + 1) } : undefined;
}

type AssistantModel = {
  content?: { type: string; text?: string }[];
  usage?: { input?: number; output?: number; totalTokens?: number };
};

async function commitAnswer(conv: Conversation, answer: unknown): Promise<{ reply: string; usage?: { contextTokens: number; contextWindow?: number } }> {
  const entry = await conv.commit((tx) => tx.entry(AssistantEntry, answer as never), ctx);
  const msg = (entry?.model?.[0] as AssistantModel | undefined) ?? {};
  const content = msg.content ?? [];
  const reply = content.filter((c) => c.type === "text").map((c) => c.text ?? "").join("").trim();
  const fromUsage = msg.usage
    ? Math.round((msg.usage.input ?? 0) + (msg.usage.output ?? 0) || msg.usage.totalTokens || 0)
    : 0;
  const contextTokens = fromUsage > 0 ? fromUsage : Math.max(1, Math.ceil(reply.length / 4));
  let contextWindow: number | undefined;
  try {
    const agent = await conv.agent(ctx);
    const ref = agent.model;
    if (ref) {
      const model = modelsRef.getModel(ref.provider, ref.modelId);
      if (model?.contextWindow) contextWindow = model.contextWindow;
    }
  } catch {
    /* model catalog unavailable — window optional */
  }
  if (!contextWindow && process.env.PI_FAUX === "1") contextWindow = 200_000;
  return { reply, usage: { contextTokens, contextWindow } };
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

type Feed = { items: ProgressItem[]; listeners: Set<(item: ProgressItem) => void> };
const feeds = new Map<string, Feed>();
const opening = new Map<string, Promise<Feed>>();
// Cap the replay buffer so a long-lived conversation cannot grow without bound.
const FEED_LIMIT = 5000;

/**
 * Live progress feed for one conversation. Attach it before the turn commits so the feed holds the whole
 * turn: the stream reports commits after it mounts, and the SSE endpoint replays what it captured.
 */
function feedFor(conversationId: string): Promise<Feed> {
  const known = feeds.get(conversationId);
  if (known) return Promise.resolve(known);
  const started = opening.get(conversationId);
  if (started) return started;
  // pi-durable addresses conversation documents by the numeric id; the saved map holds it as a string.
  const id = Number(conversationId);
  if (!Number.isSafeInteger(id)) return Promise.reject(new Error(`bad conversation id: ${conversationId}`));
  const feed = (async () => {
    const stream = await watchEvents(harness, id as never, ctx);
    const map = progressMapper();
    const created: Feed = { items: [], listeners: new Set() };
    feeds.set(conversationId, created);
    stream.start(async (events) => {
      for (const item of map(events)) {
        created.items.push(item);
        if (created.items.length > FEED_LIMIT) created.items.splice(0, created.items.length - FEED_LIMIT);
        for (const listener of created.listeners) listener(item);
      }
    });
    const drop = () => {
      feeds.delete(conversationId);
      void stream.stop().catch(() => {});
    };
    void stream.closed.then(drop, drop);
    return created;
  })();
  opening.set(conversationId, feed);
  void feed.then(
    () => opening.delete(conversationId),
    () => opening.delete(conversationId),
  );
  return feed;
}

async function admit(body: SubmitBody) {
  loadKeys();
  const known = saved.requests[body.requestId];
  if (!known && !body.text?.trim()) throw new Error("empty input for a new request");
  let conv = known ? await harness.conversation(known as never, ctx) : undefined;
  if (!conv && body.conversationId) conv = await harness.conversation(body.conversationId as never, ctx);
  if (!conv) conv = await harness.createConversation({ ownership: { kind: "ownerless" } }, ctx);
  remember(String(conv.id), body.threadKey, body.requestId);
  // Progress must attach before this turn's commits reach the conversation.
  void feedFor(String(conv.id)).catch((err) => console.error("progress feed unavailable:", err instanceof Error ? err.message : err));
  if (!known) {
    await conv.configure({ model: modelRef(body.model) ?? null, cwd: body.cwd ?? null, tools: toolsFor(body.mcps), instructions: body.instructions || null }, ctx);
  }
  const submission = await conv.submit({ type: "input", content: body.text || "(resumed)", requestId: body.requestId }, ctx);
  submissions.set(body.requestId, submission);
  return { conversationId: String(conv.id) };
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
    const { reason, detail } = settled as { reason?: unknown; detail?: unknown };
    const why = typeof detail === "string" ? detail : detail ? JSON.stringify(detail) : "";
    return { status: "unanswered", conversationId: known, error: [reason ?? "unanswered", why].filter(Boolean).join(": ") };
  }
  const { reply, usage } = await commitAnswer(conv, settled.answer);
  return { status: "done", conversationId: known, reply, usage };
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

/** SSE of live progress for a thread's newest conversation: replays the feed, then follows it. */
async function streamEvents(req: IncomingMessage, res: ServerResponse) {
  const thread = new URL(req.url ?? "", "http://x").searchParams.get("thread") ?? "";
  // ponytail: last-inserted conversation for the thread; fine while threads map ~1:1 to conversations.
  const conversationId = Object.entries(threads).findLast(([, key]) => key === thread)?.[0];
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
  if (!conversationId) return res.end();
  let feed: Feed;
  try {
    feed = await feedFor(conversationId);
  } catch (err) {
    console.error("progress feed unavailable:", err instanceof Error ? err.message : err);
    return res.end();
  }
  const send = (item: ProgressItem) => res.write(`data: ${JSON.stringify(item)}\n\n`);
  for (const item of feed.items) send(item);
  feed.listeners.add(send);
  const ping = setInterval(() => res.write(": ping\n\n"), 15_000);
  res.on("close", () => {
    clearInterval(ping);
    feed.listeners.delete(send);
  });
}

createServer(async (req, res) => {
  try {
    if (req.method === "GET" && req.url?.startsWith("/events?")) return await streamEvents(req, res);
    if (req.method === "GET" && req.url === "/health") return send(res, 200, { ok: true, faux: process.env.PI_FAUX === "1" });
    if (req.method === "POST" && req.url === "/submit") return send(res, 200, await admit(JSON.parse(await read(req)) as SubmitBody));
    if (req.method === "POST" && req.url === "/wait") {
      const { requestId, timeoutMs } = JSON.parse(await read(req)) as { requestId: string; timeoutMs?: number };
      return send(res, 200, await waitFor(requestId, Math.min(timeoutMs ?? 50_000, 50_000)));
    }
    if (req.method === "POST" && req.url === "/reload") {
      await loadMcp();
      applyCustomProviders(modelsRef);
      return send(res, 200, {
        ok: true,
        tools: mcpTools.map((t) => t.tool.name),
        customProviders: [...customProviderIds],
      });
    }
    if (req.method === "GET" && req.url === "/tools") return send(res, 200, mcpTools.map((t) => ({ name: t.tool.name, group: t.group })));
    if (req.method === "POST" && req.url === "/abort") {
      const { conversationId } = JSON.parse(await read(req)) as { conversationId: string };
      const conv = await harness.conversation(conversationId as never, ctx);
      await conv?.abort(ctx);
      return send(res, 200, { ok: true });
    }
    send(res, 404, { error: "not found" });
  } catch (err) {
    if (res.headersSent) return void res.end();
    send(res, 500, { error: err instanceof Error ? err.message : String(err) });
  }
}).listen(port, "127.0.0.1", () => console.log(`pi harness on 127.0.0.1:${port} (${dirname(join(dataDir, "harness.sqlite"))})`));

const shutdown = () => void harness.close(ctx).finally(() => process.exit(0));
for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, shutdown);
if (process.env.PI_PARENT_PIPE === "1") {
  process.stdin.resume();
  process.stdin.on("end", shutdown);
  process.stdin.on("close", shutdown);
}
