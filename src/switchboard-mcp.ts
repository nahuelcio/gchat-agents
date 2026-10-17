/**
 * Switchboard MCP (stdio): tools for the coding agent to attach state to the
 * current chat thread. Thread key + admin URL come from the process env set by
 * the driver when it spawns this server.
 *
 *   SWITCHBOARD_ADMIN_URL  http://127.0.0.1:<adminPort>
 *   SWITCHBOARD_THREAD_KEY thread key in SessionStore
 */
import { pathToFileURL } from "node:url";

const TOOLS = [
  {
    name: "link_work_item",
    description:
      "Attach an Azure DevOps work item to the current Switchboard chat thread so it appears in the context panel. Call this right after you create or choose a work item for this thread.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "number", description: "Numeric Azure DevOps work item id" },
      },
      required: ["id"],
    },
  },
  {
    name: "clear_work_item",
    description: "Remove the work item link from the current Switchboard chat thread.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
] as const;

/** How drivers point the agent CLI at this MCP server for one turn. */
export interface SwitchboardMcp {
  serverPath: string;
  adminUrl: string;
}

export function mcpEnv(threadKey: string, adminUrl: string): Record<string, string> {
  return {
    SWITCHBOARD_ADMIN_URL: adminUrl.replace(/\/$/, ""),
    SWITCHBOARD_THREAD_KEY: threadKey,
  };
}

/** Claude Code `--mcp-config` JSON. */
export function claudeMcpConfig(serverPath: string, threadKey: string, adminUrl: string): string {
  return JSON.stringify({
    mcpServers: {
      switchboard: {
        command: process.execPath,
        args: [serverPath],
        env: mcpEnv(threadKey, adminUrl),
      },
    },
  });
}

/** OpenCode `OPENCODE_CONFIG_CONTENT` fragment (merges into the active config). */
export function opencodeMcpConfig(serverPath: string, threadKey: string, adminUrl: string): string {
  return JSON.stringify({
    mcp: {
      switchboard: {
        type: "local",
        enabled: true,
        command: [process.execPath, serverPath],
        env: mcpEnv(threadKey, adminUrl),
      },
    },
  });
}

export const SWITCHBOARD_HINT =
  "When you create or select an Azure DevOps work item for this thread, call the switchboard MCP tool link_work_item with its numeric id so the chat panel can show it. Use clear_work_item to unlink.";

export async function callAdmin(
  path: string,
  body: unknown,
  env: NodeJS.ProcessEnv = process.env,
  fetchFn: typeof fetch = fetch,
): Promise<unknown> {
  const base = env.SWITCHBOARD_ADMIN_URL?.replace(/\/$/, "");
  const threadKey = env.SWITCHBOARD_THREAD_KEY;
  if (!base) throw new Error("SWITCHBOARD_ADMIN_URL is not set");
  if (!threadKey) throw new Error("SWITCHBOARD_THREAD_KEY is not set");
  const res = await fetchFn(`${base}${path}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ threadKey, ...(body as object) }),
  });
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data;
}

export async function runTool(
  name: string,
  args: Record<string, unknown>,
  env: NodeJS.ProcessEnv = process.env,
  fetchFn: typeof fetch = fetch,
): Promise<string> {
  if (name === "link_work_item") {
    const id = Number(args.id);
    if (!Number.isInteger(id) || id <= 0) throw new Error("id must be a positive integer");
    await callAdmin("/api/work-item", { id }, env, fetchFn);
    return `Linked work item #${id} to this thread.`;
  }
  if (name === "clear_work_item") {
    await callAdmin("/api/work-item", { id: null }, env, fetchFn);
    return "Cleared the work item on this thread.";
  }
  throw new Error(`unknown tool: ${name}`);
}

type JsonRpc = {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
};

function respond(id: string | number | null | undefined, result: unknown): string {
  return frame({ jsonrpc: "2.0", id: id ?? null, result });
}

function fail(id: string | number | null | undefined, message: string): string {
  return frame({ jsonrpc: "2.0", id: id ?? null, error: { code: -32000, message } });
}

function frame(msg: unknown): string {
  const body = JSON.stringify(msg);
  return `Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`;
}

/** Handle one JSON-RPC request; returns the framed response or undefined for notifications. */
export async function handleRpc(
  msg: JsonRpc,
  env: NodeJS.ProcessEnv = process.env,
  fetchFn: typeof fetch = fetch,
): Promise<string | undefined> {
  const { id, method, params } = msg;
  if (!method) return undefined;
  if (method === "initialize") {
    return respond(id, {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "switchboard", version: "0.1.0" },
    });
  }
  if (method === "notifications/initialized" || method === "initialized") return undefined;
  if (method === "tools/list") return respond(id, { tools: [...TOOLS] });
  if (method === "tools/call") {
    const name = String(params?.name ?? "");
    const args = (params?.arguments ?? {}) as Record<string, unknown>;
    try {
      const text = await runTool(name, args, env, fetchFn);
      return respond(id, { content: [{ type: "text", text }] });
    } catch (err) {
      return fail(id, err instanceof Error ? err.message : String(err));
    }
  }
  if (method === "ping") return respond(id, {});
  return fail(id, `unsupported method: ${method}`);
}

async function serveStdio(): Promise<void> {
  let buf = Buffer.alloc(0);
  for await (const chunk of process.stdin) {
    buf = Buffer.concat([buf, chunk as Buffer]);
    for (;;) {
      const headerEnd = buf.indexOf("\r\n\r\n");
      if (headerEnd < 0) break;
      const headers = buf.slice(0, headerEnd).toString("utf8");
      const match = headers.match(/Content-Length:\s*(\d+)/i);
      if (!match) {
        buf = buf.slice(headerEnd + 4);
        continue;
      }
      const len = Number(match[1]);
      const bodyStart = headerEnd + 4;
      if (buf.length < bodyStart + len) break;
      const json = buf.slice(bodyStart, bodyStart + len).toString("utf8");
      buf = buf.slice(bodyStart + len);
      let msg: JsonRpc;
      try {
        msg = JSON.parse(json) as JsonRpc;
      } catch {
        continue;
      }
      const out = await handleRpc(msg);
      if (out) process.stdout.write(out);
    }
  }
}

const entry = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (entry) {
  serveStdio().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
