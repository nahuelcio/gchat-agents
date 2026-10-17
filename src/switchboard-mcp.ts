/**
 * Switchboard MCP (stdio): tools for the coding agent to drive the current chat
 * thread (work item, repo, app, schedules). Env set by the driver per turn:
 *
 *   SWITCHBOARD_ADMIN_URL  http://127.0.0.1:<adminPort>
 *   SWITCHBOARD_THREAD_KEY thread key in SessionStore
 */
import { pathToFileURL } from "node:url";

const TOOLS = [
  {
    name: "invite_agent",
    description:
      "Add an agent (from Switchboard's catalog) to the current chat room when a person in the chat asked for it, e.g. 'agregá a @qa'. Fails if no person asked for that agent.",
    inputSchema: {
      type: "object",
      properties: { name: { type: "string", description: "Agent name, with or without @" } },
      required: ["name"],
    },
  },
  {
    name: "link_work_item",
    description:
      "Attach an Azure DevOps work item to the current Switchboard chat thread so it appears in the context panel. Call this right after you create or choose a work item for this thread.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "number", description: "Numeric Azure DevOps work item id" } },
      required: ["id"],
    },
  },
  {
    name: "clear_work_item",
    description: "Remove the work item link from the current Switchboard chat thread.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "list_repos",
    description: "List repo names configured in Switchboard that can be attached to this thread.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "attach_repo",
    description:
      "Create a per-thread git worktree for a configured repo and make the agent work there. Fails if the thread already has a repo — call detach_repo first.",
    inputSchema: {
      type: "object",
      properties: { repo: { type: "string", description: "Configured repo name (see list_repos)" } },
      required: ["repo"],
    },
  },
  {
    name: "detach_repo",
    description: "Stop the thread app if running and remove the worktree. The git branch is kept.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "thread_status",
    description: "Read the current thread context: repo, branch, worktree, work item, app, model.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "start_app",
    description: "Start the repo's configured up command for this thread's worktree (needs attach_repo first).",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "stop_app",
    description: "Stop the app started with start_app for this thread.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "list_schedules",
    description: "List Switchboard cron schedules (id, name, when, next run).",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "create_schedule",
    description:
      "Create a recurring agent job. cron is 5 fields (minute hour day-of-month month day-of-week), local time. Uses this thread's space and repo when set.",
    inputSchema: {
      type: "object",
      properties: {
        cron: { type: "string", description: 'e.g. "0 9 * * 1-5" for weekdays at 09:00' },
        prompt: { type: "string", description: "What the agent should do on each run" },
        name: { type: "string", description: "Optional short label" },
      },
      required: ["cron", "prompt"],
    },
  },
  {
    name: "update_schedule",
    description: "Pause/resume or edit a schedule by id.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        enabled: { type: "boolean" },
        cron: { type: "string" },
        prompt: { type: "string" },
        name: { type: "string" },
      },
      required: ["id"],
    },
  },
  {
    name: "delete_schedule",
    description: "Delete a schedule by id.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
    },
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

function withThreadArg(tool: (typeof TOOLS)[number]) {
  const schema = tool.inputSchema as { type: string; properties?: Record<string, unknown>; required?: string[] };
  return {
    ...tool,
    inputSchema: {
      ...schema,
      properties: { ...schema.properties, thread: { type: "string", description: "Switchboard thread id given in your conversation ([Switchboard thread: …]). Required unless the server already knows it." } },
    },
  };
}

export function switchboardThreadNote(threadKey: string): string {
  return `[Switchboard thread: ${threadKey}. Pass it as "thread" when you call switchboard tools.]`;
}

export function opencodeMcpArgs(serverPath: string, adminUrl: string): string[] {
  return ["mcp", "add", "switchboard", "--global", "--env", `SWITCHBOARD_ADMIN_URL=${adminUrl}`, "--", process.execPath, serverPath];
}

export const SWITCHBOARD_HINT = [
  "You have Switchboard MCP tools for this chat thread.",
  "After creating or choosing an Azure work item, call link_work_item.",
  "To work in a configured git repo, call list_repos then attach_repo (detach_repo to leave).",
  "Use start_app / stop_app for the repo's configured up command.",
  "Use thread_status to inspect the panel state.",
  "For recurring work, create_schedule / list_schedules / update_schedule / delete_schedule.",
].join(" ");

export interface AdminCall {
  method?: string;
  body?: Record<string, unknown>;
  /** Merge SWITCHBOARD_THREAD_KEY into body or query (default true). */
  thread?: boolean;
  query?: Record<string, string>;
}

export async function callAdmin(
  path: string,
  opts: AdminCall = {},
  env: NodeJS.ProcessEnv = process.env,
  fetchFn: typeof fetch = fetch,
): Promise<unknown> {
  const base = env.SWITCHBOARD_ADMIN_URL?.replace(/\/$/, "");
  const threadKey = env.SWITCHBOARD_THREAD_KEY;
  if (!base) throw new Error("SWITCHBOARD_ADMIN_URL is not set");
  if (opts.thread !== false && !threadKey) throw new Error("SWITCHBOARD_THREAD_KEY is not set");

  const method = opts.method ?? (opts.body !== undefined ? "PUT" : "GET");
  const query = new URLSearchParams(opts.query);
  if (method === "GET" && opts.thread !== false && threadKey) query.set("threadKey", threadKey);
  const qs = query.toString();
  const url = `${base}${path}${qs ? `?${qs}` : ""}`;

  const res = await fetchFn(url, {
    method,
    headers: opts.body ? { "content-type": "application/json" } : undefined,
    body: opts.body
      ? JSON.stringify({ ...(opts.thread !== false && threadKey ? { threadKey } : {}), ...opts.body })
      : undefined,
  });
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data;
}

type ThreadStatus = {
  repo?: string | null;
  branch?: string | null;
  worktree?: string | null;
  workItemId?: number | null;
  agent?: string;
  model?: string | null;
  space?: string;
  app?: { running?: boolean; port?: number };
  context?: string | null;
  repos?: string[];
};

export async function runTool(
  name: string,
  args: Record<string, unknown>,
  baseEnv: NodeJS.ProcessEnv = process.env,
  fetchFn: typeof fetch = fetch,
): Promise<string> {
  const thread = typeof args.thread === "string" ? args.thread.trim() : "";
  const env = thread ? { ...baseEnv, SWITCHBOARD_THREAD_KEY: thread } : baseEnv;
  if (name === "invite_agent") {
    const agent = String(args.name ?? "").replace(/^@/, "").trim();
    if (!agent) throw new Error("name is required");
    await callAdmin("/api/thread/invite", { method: "POST", body: { name: agent } }, env, fetchFn);
    return `@${agent} joined the room.`;
  }
  if (name === "link_work_item") {
    const id = Number(args.id);
    if (!Number.isInteger(id) || id <= 0) throw new Error("id must be a positive integer");
    await callAdmin("/api/work-item", { body: { id } }, env, fetchFn);
    return `Linked work item #${id} to this thread.`;
  }
  if (name === "clear_work_item") {
    await callAdmin("/api/work-item", { body: { id: null } }, env, fetchFn);
    return "Cleared the work item on this thread.";
  }
  if (name === "list_repos") {
    const data = (await callAdmin("/api/thread/repos", { thread: false }, env, fetchFn)) as { repos?: string[] };
    const repos = data.repos ?? [];
    return repos.length ? `Configured repos: ${repos.join(", ")}` : "No repos configured in Switchboard yet.";
  }
  if (name === "attach_repo") {
    const repo = String(args.repo ?? "").trim();
    if (!repo) throw new Error("repo is required");
    const data = (await callAdmin("/api/thread/repo", { body: { repo } }, env, fetchFn)) as {
      worktree?: string;
      branch?: string;
    };
    return `Attached ${repo}. Worktree: ${data.worktree}. Branch: ${data.branch}.`;
  }
  if (name === "detach_repo") {
    const data = (await callAdmin("/api/thread/repo", { body: { repo: null } }, env, fetchFn)) as {
      branchKept?: string;
    };
    return data.branchKept ? `Detached. Branch ${data.branchKept} kept in the repo.` : "No repo was attached.";
  }
  if (name === "thread_status") {
    const s = (await callAdmin("/api/thread/status", {}, env, fetchFn)) as ThreadStatus;
    return [
      `Repo: ${s.repo ?? "none"}`,
      s.branch ? `Branch: ${s.branch}` : undefined,
      s.worktree ? `Worktree: ${s.worktree}` : undefined,
      s.workItemId ? `Work item: #${s.workItemId}` : "Work item: none",
      `Agent: ${s.agent ?? "default"}${s.model ? ` · ${s.model}` : ""}`,
      `App: ${s.app?.running ? `running on :${s.app.port}` : "stopped"}`,
      s.context ? `Session: ${s.context}` : undefined,
      s.repos?.length ? `Configured repos: ${s.repos.join(", ")}` : undefined,
    ]
      .filter(Boolean)
      .join("\n");
  }
  if (name === "start_app") {
    const data = (await callAdmin("/api/thread/app", { body: { action: "up" } }, env, fetchFn)) as { port?: number };
    return `App starting on http://localhost:${data.port}`;
  }
  if (name === "stop_app") {
    const data = (await callAdmin("/api/thread/app", { body: { action: "down" } }, env, fetchFn)) as { stopped?: boolean };
    return data.stopped ? "App stopped." : "The app was not running.";
  }
  if (name === "list_schedules") {
    const jobs = (await callAdmin("/api/schedules", { method: "GET", thread: false }, env, fetchFn)) as {
      id: string;
      name: string;
      when?: string;
      cron: string;
      enabled: boolean;
      nextRunAt?: string;
    }[];
    if (!Array.isArray(jobs) || jobs.length === 0) return "No schedules.";
    return jobs
      .map((j) => `${j.id} · ${j.name} · ${j.when ?? j.cron} · ${j.enabled ? `next ${j.nextRunAt ?? "?"}` : "paused"}`)
      .join("\n");
  }
  if (name === "create_schedule") {
    const cron = String(args.cron ?? "").trim();
    const prompt = String(args.prompt ?? "").trim();
    if (!cron || !prompt) throw new Error("cron and prompt are required");
    const status = (await callAdmin("/api/thread/status", {}, env, fetchFn)) as ThreadStatus;
    const jobs = (await callAdmin(
      "/api/schedules",
      {
        method: "POST",
        thread: false,
        body: {
          cron,
          prompt,
          ...(typeof args.name === "string" && args.name.trim() && { name: args.name.trim() }),
          space: status.space || "team-chat",
          ...(status.repo && { repo: status.repo }),
        },
      },
      env,
      fetchFn,
    )) as { id: string; name: string; when?: string; nextRunAt?: string }[];
    const created = Array.isArray(jobs) ? jobs[jobs.length - 1] : undefined;
    if (!created) return "Schedule created.";
    return `Scheduled ${created.id}: ${created.name} · ${created.when ?? cron}. Next ${created.nextRunAt ?? "?"}.`;
  }
  if (name === "update_schedule") {
    const id = String(args.id ?? "").trim();
    if (!id) throw new Error("id is required");
    const patch: Record<string, unknown> = { id };
    if (typeof args.enabled === "boolean") patch.enabled = args.enabled;
    if (typeof args.cron === "string") patch.cron = args.cron;
    if (typeof args.prompt === "string") patch.prompt = args.prompt;
    if (typeof args.name === "string") patch.name = args.name;
    await callAdmin("/api/schedules/update", { method: "POST", thread: false, body: patch }, env, fetchFn);
    return `Updated schedule ${id}.`;
  }
  if (name === "delete_schedule") {
    const id = String(args.id ?? "").trim();
    if (!id) throw new Error("id is required");
    await callAdmin("/api/schedules/delete", { method: "POST", thread: false, body: { id } }, env, fetchFn);
    return `Deleted schedule ${id}.`;
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

let lineMode = false;

function frame(msg: unknown): string {
  const body = JSON.stringify(msg);
  if (lineMode) return `${body}\n`;
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
  if (method === "tools/list") return respond(id, { tools: TOOLS.map(withThreadArg) });
  if (method === "tools/call") {
    const name = String(params?.name ?? "");
    const toolArgs = (params?.arguments ?? {}) as Record<string, unknown>;
    try {
      const text = await runTool(name, toolArgs, env, fetchFn);
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
      if (buf.toString("utf8", 0, Math.min(buf.length, 16)).trimStart().startsWith("{")) {
        lineMode = true;
        const nl = buf.indexOf("\n");
        if (nl < 0) break;
        const line = buf.slice(0, nl).toString("utf8").trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let msg: JsonRpc;
        try {
          msg = JSON.parse(line) as JsonRpc;
        } catch {
          continue;
        }
        const out = await handleRpc(msg);
        if (out) process.stdout.write(out);
        continue;
      }
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
