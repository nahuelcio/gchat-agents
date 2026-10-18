import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createInterface } from "node:readline";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { Type } from "@earendil-works/pi-ai";
import { createModels, type MutableModels } from "@earendil-works/pi-ai/models";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { AssistantEntry, createRegistry, defineExtension, defineTool, Harness, type Conversation } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { CodingTools } from "@earendil-works/pi-durable/tools";

const dataDir = process.env.DATA_DIR ?? "./data";
const port = Number(process.env.PI_PORT ?? 8090);
const adminUrl = (process.env.SWITCHBOARD_ADMIN_URL ?? "http://127.0.0.1:8081").replace(/\/$/, "");
const defaultModel = process.env.PI_MODEL ?? "";
const threadsFile = join(dataDir, "harness-threads.json");
const SECRET = /KEY|TOKEN|SECRET|PASSWORD|SERVICE_ACCOUNT|CREDENTIAL/i;

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

function models(): MutableModels {
  if (process.env.PI_FAUX !== "1") return builtinModels();
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
  const m = createModels();
  m.setProvider(faux.provider);
  return m;
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
let mcpTools: { group: string; tool: ReturnType<typeof defineTool> }[] = [];

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
  const coding = all || groups.includes("coding") ? [...(CodingTools.tools ?? [])] : [];
  return [...coding, ...mcpTools.filter((t) => all || groups.includes(t.group)).map((t) => t.tool)];
}

const registry = createRegistry();
registry.install(CodingTools);
await loadMcp().catch((e) => console.error("MCP tools unavailable:", e instanceof Error ? e.message : e));

const shellEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !SECRET.test(k)));
const harness = await Harness.open(
  await openNodeSqliteStorage(join(dataDir, "harness.sqlite")),
  {
    models: models(),
    registry,
    env: (target) => new NodeExecutionEnv({ cwd: target.cwd ?? dataDir, shellEnv }),
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

async function answerText(conv: Conversation, answer: unknown): Promise<string> {
  const entry = await conv.commit((tx) => tx.entry(AssistantEntry, answer as never), ctx);
  const content = (entry?.model?.[0] as { content?: { type: string; text?: string }[] } | undefined)?.content ?? [];
  return content.filter((c) => c.type === "text").map((c) => c.text ?? "").join("").trim();
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
}

const submissions = new Map<string, Awaited<ReturnType<Conversation["submit"]>>>();

async function admit(body: SubmitBody) {
  loadKeys();
  const known = saved.requests[body.requestId];
  if (!known && !body.text?.trim()) throw new Error("empty input for a new request");
  let conv = known ? await harness.conversation(known as never, ctx) : undefined;
  if (!conv && body.conversationId) conv = await harness.conversation(body.conversationId as never, ctx);
  if (!conv) conv = await harness.createConversation({ ownership: { kind: "ownerless" } }, ctx);
  remember(String(conv.id), body.threadKey, body.requestId);
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
  return { status: "done", conversationId: known, reply: await answerText(conv, settled.answer) };
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

createServer(async (req, res) => {
  try {
    if (req.method === "GET" && req.url === "/health") return send(res, 200, { ok: true, faux: process.env.PI_FAUX === "1" });
    if (req.method === "POST" && req.url === "/submit") return send(res, 200, await admit(JSON.parse(await read(req)) as SubmitBody));
    if (req.method === "POST" && req.url === "/wait") {
      const { requestId, timeoutMs } = JSON.parse(await read(req)) as { requestId: string; timeoutMs?: number };
      return send(res, 200, await waitFor(requestId, Math.min(timeoutMs ?? 50_000, 50_000)));
    }
    if (req.method === "POST" && req.url === "/reload") {
      await loadMcp();
      return send(res, 200, { ok: true, tools: mcpTools.map((t) => t.tool.name) });
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
