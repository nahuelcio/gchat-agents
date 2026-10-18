import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
const saved: { threads: Record<string, string>; requests: Record<string, string> } = existsSync(threadsFile)
  ? JSON.parse(readFileSync(threadsFile, "utf8"))
  : { threads: {}, requests: {} };
const threads = saved.threads;
const remember = (conversationId: string, threadKey: string, requestId: string) => {
  threads[conversationId] = threadKey;
  saved.requests[requestId] = conversationId;
  writeFileSync(threadsFile, JSON.stringify(saved));
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
  const respond = (context: { messages?: { role: string; content: unknown }[] }) => {
    const last = [...(context.messages ?? [])].reverse()[0];
    const text = lastUserText(context);
    if (last?.role === "toolResult") return fauxAssistantMessage(`Tool said: ${text.slice(0, 200)}`);
    const read = text.match(/READ:(\S+)/);
    if (read) return fauxAssistantMessage([fauxToolCall("read", { path: read[1] })], { stopReason: "toolUse" });
    const bash = text.match(/BASH:(.+)$/m);
    if (bash) return fauxAssistantMessage([fauxToolCall("bash", { command: bash[1] })], { stopReason: "toolUse" });
    return fauxAssistantMessage(`Echo: ${text.split("\n---\n").pop()?.trim()}`);
  };
  faux.setResponses(Array.from({ length: 10_000 }, () => respond));
  const m = createModels();
  m.setProvider(faux.provider);
  return m;
}

async function admin(path: string, body: unknown): Promise<unknown> {
  const res = await fetch(`${adminUrl}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data;
}

const createXlsx = defineTool({
  name: "create_xlsx",
  description: "Create an .xlsx in the shared Google Drive folder and return its link. Numbers stay numbers. One sheet per table, first row headers.",
  parameters: Type.Object({
    title: Type.String(),
    sheets: Type.Array(Type.Object({ name: Type.String(), rows: Type.Array(Type.Array(Type.Any())) })),
  }),
  replay: "safe",
  execute: async (args, api) => {
    const threadKey = threads[api.conversationId] ?? "";
    const out = (await admin("/api/drive/xlsx", { threadKey, taskId: `pi:${api.taskId}`, title: args.title, sheets: args.sheets })) as {
      file: { webViewLink?: string };
      rows: number;
    };
    return { output: [{ type: "text", text: `Created: ${out.file.webViewLink ?? "(no link)"} (${out.rows} rows)` }] };
  },
});

const listSpreadsheets = defineTool({
  name: "list_spreadsheets",
  description: "List the .xlsx files in the shared Google Drive folder.",
  parameters: Type.Object({}),
  replay: "safe",
  execute: async (_args, api) => {
    const threadKey = threads[api.conversationId] ?? "";
    const res = await fetch(`${adminUrl}/api/drive/spreadsheets?threadKey=${encodeURIComponent(threadKey)}`);
    const data = (await res.json()) as { name: string; webViewLink?: string }[] | { error: string };
    if (!res.ok || !Array.isArray(data)) throw new Error((data as { error?: string }).error ?? `HTTP ${res.status}`);
    return { output: [{ type: "text", text: data.map((f) => `${f.name} · ${f.webViewLink ?? ""}`).join("\n") || "No spreadsheets yet." }] };
  },
});

const Switchboard = defineExtension({ name: "switchboard", tools: [createXlsx, listSpreadsheets] });
const registry = createRegistry();
registry.install(CodingTools);
registry.install(Switchboard);
const allTools = new Map([...(CodingTools.tools ?? []), ...(Switchboard.tools ?? [])].map((t) => [t.name, t]));

loadKeys();
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

type TurnBody = { conversationId?: string; threadKey: string; requestId: string; text: string; cwd?: string; model?: string; tools?: string[] };

function loadKeys() {
  const file = join(dataDir, "pi-keys.json");
  if (!existsSync(file)) return;
  for (const [name, value] of Object.entries(JSON.parse(readFileSync(file, "utf8")) as Record<string, string>)) {
    if (value) process.env[name] = value;
  }
}

async function turn(body: TurnBody) {
  loadKeys();
  const known = saved.requests[body.requestId] ?? body.conversationId;
  let conv = known ? await harness.conversation(known as never, ctx) : undefined;
  if (!conv) conv = await harness.createConversation({ ownership: { kind: "ownerless" } }, ctx);
  remember(String(conv.id), body.threadKey, body.requestId);
  const tools = (body.tools ?? [...allTools.keys()]).flatMap((n) => (allTools.get(n) ? [allTools.get(n)!] : []));
  await conv.configure({ model: modelRef(body.model) ?? null, cwd: body.cwd ?? null, tools }, ctx);
  const submission = await conv.submit({ type: "input", content: body.text, requestId: body.requestId }, ctx);
  const settled = await submission.wait(ctx);
  if (settled.status !== "done" || settled.type !== "input") {
    const { reason, detail } = settled as { reason?: unknown; detail?: unknown };
    const why = typeof detail === "string" ? detail : detail ? JSON.stringify(detail) : "";
    return { conversationId: String(conv.id), status: settled.status, error: [reason ?? "unanswered", why].filter(Boolean).join(": ") };
  }
  return { conversationId: String(conv.id), status: "done", reply: await answerText(conv, settled.answer) };
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
    if (req.method === "POST" && req.url === "/turn") return send(res, 200, await turn(JSON.parse(await read(req)) as TurnBody));
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
