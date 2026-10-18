import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { requestStop } from "./personas.js";
import { join } from "node:path";
import { adoProjects, adoRepos, cloneRepo, type DetectedAdo, type FetchFn } from "./integrations.js";
import type { DetectedAgent } from "./agents.js";
import { compressBody, withEncoding } from "./compress.js";
import { contextLine, type HandlerDeps } from "./handler.js";
import { serveMedia } from "./media.js";
import { TEAM_PREFIX, teamDelete, teamInvite, teamMembers, teamSend, teamThread, THREAD_ID, type TeamAttachmentInput } from "./team.js";
import type { TranscriptStore } from "./transcripts.js";
import type { GoogleConnection } from "./google.js";
import type { Health } from "./health.js";
import type { ShareToken } from "./share.js";
import { describeCron, jobName, type NewJob, type Scheduler, type ScheduleStore } from "./schedules.js";
import { suggestSchedule } from "./schedule-suggest.js";
import { readBody } from "./server.js";
import { serveStatic } from "./static.js";
import type { Settings, SettingsStore } from "./settings.js";
import type { SessionStore } from "./store.js";
import { threadSlug, type Workspaces } from "./workspace.js";

export interface AdminContext {
  store?: SessionStore;
  workspaces?: Workspaces;
  /** Where repos cloned from Azure DevOps go. */
  reposDir?: string;
  /** Built React app (web/dist). */
  webDir?: string;
  fetch?: FetchFn;
  /** ADO credentials from the machine's `ado` CLI setup. */
  detectAdo?: () => DetectedAdo | undefined;
  detectAgents?: () => Promise<DetectedAgent[]>;
  piModels?: () => Promise<string[]>;
  handler?: HandlerDeps;
  schedules?: ScheduleStore;
  scheduler?: Scheduler;
  health?: Health;
  /** Public HTTPS URL of the bridge (tunnel), shown so the Chat app can be pointed at it. */
  publicUrl?: string;
  google?: GoogleConnection;
  shareToken?: ShareToken;
  transcripts?: TranscriptStore;
}

const CACHE_MS = 60_000;

/** Memoizes a slow probe for CACHE_MS; `refresh` forces a new run. Failures are not cached. */
function cached<T>(load: () => Promise<T>): (refresh: boolean) => Promise<T> {
  let entry: { at: number; value: Promise<T> } | undefined;
  return (refresh) => {
    if (refresh || !entry || Date.now() - entry.at > CACHE_MS) {
      const value = load();
      entry = { at: Date.now(), value };
      value.catch(() => (entry = undefined));
    }
    return entry.value;
  };
}


function send(res: ServerResponse, status: number, body: unknown): void {
  const type = "application/json";
  const packed = compressBody(Buffer.from(JSON.stringify(body)), res.req.headers["accept-encoding"], type);
  res.writeHead(status, withEncoding({ "content-type": type, "cache-control": "no-store" }, packed.encoding));
  res.end(packed.body);
}

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function jsonBody<T>(req: IncomingMessage): Promise<T> {
  // A JSON content type forces a CORS preflight, which this server never answers.
  if (!req.headers["content-type"]?.startsWith("application/json")) {
    throw new HttpError(415, "content-type must be application/json");
  }
  try {
    return JSON.parse(await readBody(req)) as T;
  } catch {
    throw new HttpError(400, "invalid JSON");
  }
}


/**
 * Local control plane: settings, live threads/apps, Azure DevOps repos, TokenBank models.
 * Bind it to 127.0.0.1 only — it holds secrets and decides what runs on this machine.
 */
export function createAdminServer(settings: SettingsStore, ctx: AdminContext = {}): ReturnType<typeof createServer> {
  const fetchFn: FetchFn = (url, init) => (ctx.fetch ?? fetch)(url, init);
  const agents = cached(() => ctx.detectAgents?.() ?? Promise.resolve([]));
  const piModelList = cached(() => ctx.piModels?.() ?? Promise.resolve([]));

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const parsed = new URL(req.url ?? "/", "http://localhost");
    const url = parsed.pathname;
    const method = req.method ?? "GET";

    if (!url.startsWith("/api/")) {
      if (method !== "GET") throw new HttpError(405, "method not allowed");
      if (!(await serveStatic(res, ctx.webDir, url))) throw new HttpError(404, "not found");
      return;
    }

    if (url === "/api/settings" && method === "GET") return send(res, 200, settings.get());
    if (url === "/api/settings" && method === "PUT") {
      try {
        await settings.update(await jsonBody<Partial<Settings>>(req));
      } catch (err) {
        if (err instanceof HttpError) throw err;
        throw new HttpError(400, err instanceof Error ? err.message : String(err));
      }
      return send(res, 200, settings.get());
    }

    // Switchboard MCP (and the control plane) mutate one thread via these routes.
    if (url.startsWith("/api/thread/") || url === "/api/work-item") {
      const store = ctx.store;
      if (!store) throw new HttpError(500, "session store unavailable");
      const ws = ctx.workspaces;

      if (url === "/api/thread/repos" && method === "GET") {
        return send(res, 200, { repos: Object.keys(settings.get().repos) });
      }

      if (url === "/api/thread/status" && method === "GET") {
        const threadKey = (parsed.searchParams.get("threadKey") ?? "").trim();
        if (!threadKey) throw new HttpError(400, "threadKey is required");
        const record = store.get(threadKey);
        const slug = threadSlug(threadKey);
        const options = ctx.handler?.options?.();
        return send(res, 200, {
          threadKey,
          space: record?.space ?? "team-chat",
          repo: record?.repo ?? null,
          branch: record?.branch ?? null,
          worktree: record?.worktree ?? null,
          workItemId: record?.workItemId ?? null,
          agent: record?.driver ?? settings.get().agentDriver,
          model: record?.model ?? settings.get().models[settings.get().agentDriver] ?? null,
          app: { running: ws?.isUp(slug) ?? false, port: ws?.port(slug) },
          context: record && options ? contextLine(record, options).slice(2) : null,
          repos: Object.keys(settings.get().repos),
        });
      }

      if (method !== "PUT" && method !== "POST") throw new HttpError(405, "method not allowed");
      const body = await jsonBody<Record<string, unknown>>(req);
      const threadKey = String(body.threadKey ?? "").trim();
      if (!threadKey) throw new HttpError(400, "threadKey is required");
      const record = store.get(threadKey);
      const space = record?.space ?? "team-chat";
      const slug = threadSlug(threadKey);

      if (url === "/api/thread/invite") {
        try {
          return send(res, 200, { members: await teamInvite(ctx.handler ?? (() => { throw new HttpError(409, "chat is not running"); })(), threadKey, String(body.name ?? "")) });
        } catch (err) {
          throw new HttpError(400, err instanceof Error ? err.message : String(err));
        }
      }

      if (url === "/api/work-item") {
        if (body.id === null || body.id === undefined) {
          await store.update(threadKey, space, { workItemId: undefined });
          return send(res, 200, { ok: true, workItemId: null });
        }
        const id = Number(body.id);
        if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, "id must be a positive integer");
        await store.update(threadKey, space, { workItemId: id });
        return send(res, 200, { ok: true, workItemId: id });
      }

      if (url === "/api/thread/repo") {
        if (!ws) throw new HttpError(409, "no repos configured on this bridge");
        if (body.repo === null || body.repo === "") {
          if (!record?.worktree || !record.repo) return send(res, 200, { ok: true, detached: true });
          ws.down(slug);
          await ws.remove(record.repo, record.worktree);
          await store.update(threadKey, space, { worktree: undefined, repo: undefined, branch: undefined });
          return send(res, 200, { ok: true, detached: true, branchKept: record.branch });
        }
        const repo = String(body.repo ?? "").trim();
        if (!repo) throw new HttpError(400, "repo is required (or null to detach)");
        if (record?.worktree) throw new HttpError(409, `thread already on ${record.repo}; detach first`);
        try {
          const { worktree, branch } = await ws.create(repo, slug);
          await store.update(threadKey, space, { repo, worktree, branch });
          return send(res, 200, { ok: true, repo, worktree, branch });
        } catch (err) {
          throw new HttpError(400, err instanceof Error ? err.message : String(err));
        }
      }

      if (url === "/api/thread/app") {
        if (!ws) throw new HttpError(409, "no repos configured on this bridge");
        if (!record?.worktree || !record.repo) throw new HttpError(409, "attach a repo to this thread first");
        const action = String(body.action ?? "");
        if (action === "up") {
          try {
            const { port } = await ws.up(slug, record.repo, record.worktree);
            return send(res, 200, { ok: true, running: true, port });
          } catch (err) {
            throw new HttpError(400, err instanceof Error ? err.message : String(err));
          }
        }
        if (action === "down") {
          return send(res, 200, { ok: true, stopped: ws.down(slug) });
        }
        throw new HttpError(400, 'action must be "up" or "down"');
      }

      throw new HttpError(404, "not found");
    }

    if (url === "/api/threads" && method === "GET") {
      const ws = ctx.workspaces;
      const threads = (ctx.store?.all() ?? []).map(([key, r]) => {
        const slug = threadSlug(key);
        return {
          key,
          slug,
          space: r.space,
          repo: r.repo,
          branch: r.branch,
          worktree: r.worktree,
          updatedAt: r.updatedAt,
          hasSession: Boolean(r.sessionRef),
          context: ctx.handler?.options ? contextLine(r, ctx.handler.options()).slice(2) : undefined,
          app: { running: ws?.isUp(slug) ?? false, port: ws?.port(slug) },
        };
      });
      threads.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      return send(res, 200, threads);
    }
    if (url.startsWith("/api/media/") && method === "GET") {
      const deps = ctx.handler;
      const id = url.slice("/api/media/".length);
      if (!(deps?.media && (await serveMedia(res, deps.media, id)))) throw new HttpError(404, "not found");
      return;
    }
    if (url.startsWith("/api/team/")) {
      const deps = ctx.handler;
      const transcripts = ctx.transcripts;
      if (!deps || !transcripts) throw new HttpError(500, "team chat unavailable");
      if (url === "/api/team/threads" && method === "GET") {
        const archived = parsed.searchParams.get("archived") === "1";
        return send(res, 200, transcripts.list(TEAM_PREFIX, { archived }).map(({ key, ...t }) => ({ id: key.slice(TEAM_PREFIX.length), ...t })));
      }
      const thread = method === "GET" ? (parsed.searchParams.get("thread") ?? "") : "";
      if (url === "/api/team/thread" && method === "GET") {
        if (!THREAD_ID.test(thread)) throw new HttpError(400, "bad thread id");
        const ado = ctx.detectAdo?.();
        return send(
          res,
          200,
          await teamThread(deps, transcripts, thread, {
            ...(ado && { ado: { org: ado.org, pat: ado.pat }, fetch: fetchFn }),
          }),
        );
      }
      if (url === "/api/team/send" && method === "POST") {
        const body = await jsonBody<{ thread?: string; text?: string; name?: string; attachments?: TeamAttachmentInput[] }>(req);
        const text = body.text?.trim() ?? "";
        const attachments = body.attachments ?? [];
        if (!THREAD_ID.test(body.thread ?? "") || (!text && !attachments.length)) {
          throw new HttpError(400, "thread and text or an image are required");
        }
        try {
          // The owner (loopback) gets every command; guests on the public port are restricted.
          return send(
            res,
            200,
            await teamSend(deps, transcripts, {
              thread: body.thread!,
              text,
              name: (body.name?.trim() || "Owner").slice(0, 40),
              ...(attachments.length && { attachments }),
            }),
          );
        } catch (err) {
          throw new HttpError(400, err instanceof Error ? err.message : String(err));
        }
      }
      if (url === "/api/team/members" && method === "POST") {
        const body = await jsonBody<{ thread?: string; op?: string; member?: { kind?: string; persona?: string; name?: string } }>(req);
        if (!THREAD_ID.test(body.thread ?? "")) throw new HttpError(400, "bad thread id");
        if (body.op !== "add" && body.op !== "remove") throw new HttpError(400, 'op must be "add" or "remove"');
        const m = body.member;
        const member =
          m?.kind === "agent" && m.persona ? { kind: "agent" as const, persona: m.persona } : m?.kind === "human" && m.name?.trim() ? { kind: "human" as const, name: m.name } : undefined;
        if (!member) throw new HttpError(400, "member must be { kind: agent, persona } or { kind: human, name }");
        try {
          return send(res, 200, { members: await teamMembers(deps, body.thread!, body.op, member) });
        } catch (err) {
          throw new HttpError(400, err instanceof Error ? err.message : String(err));
        }
      }
      if (url === "/api/team/stop" && method === "POST") {
        const body = await jsonBody<{ thread?: string }>(req);
        if (!THREAD_ID.test(body.thread ?? "")) throw new HttpError(400, "bad thread id");
        requestStop(`${TEAM_PREFIX}${body.thread}`);
        return send(res, 200, { ok: true });
      }
      if ((url === "/api/team/archive" || url === "/api/team/delete") && method === "POST") {
        const body = await jsonBody<{ thread?: string; archived?: boolean }>(req);
        if (!THREAD_ID.test(body.thread ?? "")) throw new HttpError(400, "bad thread id");
        if (url === "/api/team/archive") {
          await transcripts.archive(`${TEAM_PREFIX}${body.thread}`, body.archived !== false);
          return send(res, 200, { ok: true });
        }
        return send(res, 200, { ok: true, ...(await teamDelete(deps, transcripts, body.thread!)) });
      }
      throw new HttpError(404, "not found");
    }

    if (url.startsWith("/api/google")) {
      const google = ctx.google;
      if (!google) throw new HttpError(404, "not found");
      const status = () => ({ ...google.status(), ...(ctx.publicUrl && { endpoint: `${ctx.publicUrl}/google/chat` }) });
      if (url === "/api/google" && method === "GET") return send(res, 200, status());
      if (method !== "POST") throw new HttpError(405, "method not allowed");
      const body = await jsonBody<{ key?: string; space?: string }>(req);
      try {
        if (url === "/api/google/key") await google.setKey(body.key ?? "");
        else if (url === "/api/google/key/delete") await google.clearKey();
        else if (url === "/api/google/test") {
          const space = body.space ?? "";
          if (!/^spaces\/[^/\s]+$/.test(space)) throw new Error("Pick a space (spaces/XXXX)");
          await google.postMessage(space, { text: "Relay is connected. Mention me in a thread to start." });
        } else throw new HttpError(404, "not found");
      } catch (err) {
        if (err instanceof HttpError) throw err;
        // Google's API errors (403 not a member, 404 no such space) are actionable for the user as-is.
        throw new HttpError(400, err instanceof Error ? err.message : String(err));
      }
      return send(res, 200, status());
    }

    if (url === "/api/share" || url === "/api/share/rotate") {
      const token = ctx.shareToken;
      if (!token || !ctx.publicUrl) throw new HttpError(404, "sharing needs the tunnel");
      if (url === "/api/share/rotate") {
        if (method !== "POST") throw new HttpError(405, "method not allowed");
        await jsonBody(req);
        token.rotate();
      }
      // The token rides in the fragment: browsers never send it to the server or to logs.
      return send(res, 200, { link: `${ctx.publicUrl}/play#${token.value()}` });
    }

    if (url === "/api/health" && method === "GET") {
      if (!ctx.health) throw new HttpError(404, "not found");
      return send(res, 200, { ...ctx.health.snapshot(), ...(ctx.publicUrl && { endpoint: `${ctx.publicUrl}/google/chat` }) });
    }

    if (url.startsWith("/api/schedules")) {
      const schedules = ctx.schedules;
      if (!schedules || !ctx.scheduler) throw new HttpError(404, "schedules not enabled");
      const withText = () => schedules.all().map((j) => ({ ...j, when: describeCron(j.cron) }));
      if (url === "/api/schedules" && method === "GET") return send(res, 200, withText());
      if (url === "/api/schedules/log" && method === "GET") {
        const id = parsed.searchParams.get("id") ?? "";
        if (!schedules.get(id)) throw new HttpError(404, "job not found");
        return send(res, 200, { messages: ctx.transcripts?.get(`schedule/${id}`) ?? [] });
      }
      if (method !== "POST") throw new HttpError(405, "method not allowed");
      if (url === "/api/schedules/suggest") {
        const deps = ctx.handler;
        if (!deps) throw new HttpError(500, "agent unavailable");
        const { text } = await jsonBody<{ text?: string }>(req);
        try {
          return send(res, 200, await suggestSchedule(deps.driver, text ?? "", deps.config.workdir));
        } catch (err) {
          throw new HttpError(400, err instanceof Error ? err.message : String(err));
        }
      }
      const body = await jsonBody<Partial<NewJob> & { id?: string; enabled?: boolean }>(req);
      try {
        if (url === "/api/schedules") {
          const { name, prompt, cron, space, repo } = body;
          if (!prompt?.trim() || !cron) throw new Error("prompt and cron are required");
          // No Chat space = the run is only recorded in the job log.
          await schedules.add({ name: name?.trim() || jobName(prompt), prompt: prompt.trim(), cron, space: space || "team-chat", createdBy: "control plane", ...(repo && { repo }) });
        } else if (url === "/api/schedules/update" && body.id) {
          const { id, enabled, cron, prompt, name } = body;
          await schedules.update(id, { ...(enabled !== undefined && { enabled }), ...(cron && { cron }), ...(prompt && { prompt }), ...(name && { name }) });
        } else if (url === "/api/schedules/run" && body.id) {
          void ctx.scheduler.runNow(body.id); // long: report "running" now, the list shows the outcome
        } else if (url === "/api/schedules/delete" && body.id) {
          await schedules.remove(body.id);
          await ctx.transcripts?.remove(`schedule/${body.id}`);
        } else {
          throw new HttpError(404, "not found");
        }
      } catch (err) {
        if (err instanceof HttpError) throw err;
        throw new HttpError(400, err instanceof Error ? err.message : String(err));
      }
      return send(res, 200, withText());
    }

    if (url === "/api/threads/logs" && method === "GET") {
      const slug = parsed.searchParams.get("slug") ?? "";
      return send(res, 200, { logs: ctx.workspaces?.logs(slug, 200) ?? "" });
    }
    if (url === "/api/threads/down" && method === "POST") {
      const { slug } = await jsonBody<{ slug: string }>(req);
      return send(res, 200, { stopped: ctx.workspaces?.down(slug) ?? false });
    }

    const refresh = parsed.searchParams.get("refresh") === "1";
    if (url === "/api/agents" && method === "GET") return send(res, 200, await agents(refresh));
    if (url === "/api/agents/pi/models" && method === "GET") {
      return send(res, 200, await upstream(() => piModelList(refresh)));
    }

    if (url.startsWith("/api/ado/")) {
      const ado = ctx.detectAdo?.();
      if (url === "/api/ado/status" && method === "GET") {
        if (!ado) return send(res, 200, { connected: false });
        const { pat: _pat, ...info } = ado;
        return send(res, 200, { connected: true, ...info });
      }
      if (!ado) throw new HttpError(409, "Azure DevOps not configured on this machine — run `ado init`");
      if (url === "/api/ado/projects" && method === "GET") {
        return send(res, 200, await upstream(() => adoProjects(ado, fetchFn)));
      }
      if (url === "/api/ado/repos" && method === "GET") {
        const project = parsed.searchParams.get("project");
        if (!project) throw new HttpError(400, "project is required");
        return send(res, 200, await upstream(() => adoRepos(ado, project, fetchFn)));
      }
      if (url === "/api/ado/clone" && method === "POST") {
        const { project, repo } = await jsonBody<{ project: string; repo: string }>(req);
        if (!ctx.reposDir) throw new HttpError(500, "no repos directory configured");
        const found = (await upstream(() => adoRepos(ado, project, fetchFn))).find((r) => r.name === repo);
        if (!found) throw new HttpError(404, `repo "${repo}" not found in ${project}`);
        const name = repo.replace(/[^a-zA-Z0-9._-]+/g, "-");
        if (settings.get().repos[name]) throw new HttpError(409, `a repo named "${name}" is already configured`);
        // Only the URL Azure DevOps itself returned is ever cloned — never one from the request.
        const dest = join(ctx.reposDir, name);
        try {
          await cloneRepo(found.remoteUrl, dest, ado.pat);
        } catch (err) {
          throw new HttpError(502, `clone failed: ${err instanceof Error ? err.message : String(err)}`);
        }
        const repoConfig = found.defaultBranch ? { path: dest, base: found.defaultBranch } : { path: dest };
        await settings.update({ repos: { ...settings.get().repos, [name]: repoConfig } });
        return send(res, 200, settings.get());
      }
    }

    throw new HttpError(404, "not found");
  }

  return createServer((req, res) => {
    // DNS rebinding: a hostile page resolving its own name to 127.0.0.1 still sends its Host.
    const host = (req.headers.host ?? "").replace(/:\d+$/, "");
    if (host !== "127.0.0.1" && host !== "localhost") {
      send(res, 403, { error: "forbidden host" });
      return;
    }
    route(req, res).catch((err: unknown) => {
      if (err instanceof HttpError) return send(res, err.status, { error: err.message });
      console.error("[admin] request failed:", err);
      send(res, 500, { error: "internal error" });
    });
  });
}

/** Upstream (ADO / TokenBank) failures are the caller's config problem, not a crash: 502 with the reason. */
async function upstream<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (err) {
    throw new HttpError(502, err instanceof Error ? err.message : String(err));
  }
}
