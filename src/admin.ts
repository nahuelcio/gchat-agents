import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join } from "node:path";
import { adoProjects, adoRepos, cloneRepo, type DetectedAdo, type FetchFn } from "./integrations.js";
import type { DetectedAgent } from "./agents.js";
import { contextLine, type HandlerDeps } from "./handler.js";
import { serveMedia } from "./media.js";
import { TEAM_PREFIX, teamDelete, teamSend, teamThread, THREAD_ID, type TeamAttachmentInput } from "./team.js";
import type { TranscriptStore } from "./transcripts.js";
import type { GoogleConnection } from "./google.js";
import type { Health } from "./health.js";
import type { ShareToken } from "./share.js";
import { describeCron, type NewJob, type Scheduler, type ScheduleStore } from "./schedules.js";
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
  /** Installed coding agents and the models each driver can use (slow: shelled out, cached here). */
  detectAgents?: () => Promise<DetectedAgent[]>;
  opencodeModels?: () => Promise<string[]>;
  opencodeAgents?: () => Promise<string[]>;
  claudeModels?: () => Promise<string[]>;
  /** The bridge's handler deps: the team chat runs real turns through them. */
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
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
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
  const models = cached(() => ctx.opencodeModels?.() ?? Promise.resolve([]));
  const opencodeAgentList = cached(() => ctx.opencodeAgents?.() ?? Promise.resolve([]));
  const claudeModelList = cached(() => ctx.claudeModels?.() ?? Promise.resolve([]));

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
        return send(res, 200, teamThread(deps, transcripts, thread));
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
      if (method !== "POST") throw new HttpError(405, "method not allowed");
      const body = await jsonBody<Partial<NewJob> & { id?: string; enabled?: boolean }>(req);
      try {
        if (url === "/api/schedules") {
          const { name, prompt, cron, space, repo } = body;
          if (!prompt?.trim() || !cron || !space) throw new Error("prompt, cron and space are required");
          await schedules.add({ name: name?.trim() || prompt.trim().slice(0, 48), prompt: prompt.trim(), cron, space, createdBy: "control plane", ...(repo && { repo }) });
        } else if (url === "/api/schedules/update" && body.id) {
          const { id, enabled, cron, prompt, name } = body;
          await schedules.update(id, { ...(enabled !== undefined && { enabled }), ...(cron && { cron }), ...(prompt && { prompt }), ...(name && { name }) });
        } else if (url === "/api/schedules/run" && body.id) {
          void ctx.scheduler.runNow(body.id); // long: report "running" now, the list shows the outcome
        } else if (url === "/api/schedules/delete" && body.id) {
          await schedules.remove(body.id);
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
    if (url === "/api/agents/opencode/models" && method === "GET") {
      return send(res, 200, await upstream(() => models(refresh)));
    }
    if (url === "/api/agents/opencode/agents" && method === "GET") {
      return send(res, 200, await upstream(() => opencodeAgentList(refresh)));
    }
    if (url === "/api/agents/claude/models" && method === "GET") {
      return send(res, 200, await upstream(() => claudeModelList(refresh)));
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
