export interface RepoConfig {
  path: string;
  up?: string;
  base?: string;
}

export type ContextFooter = "every" | "every5" | "above60" | "never";

export interface Settings {
  agentDriver: "opencode" | "claude";
  models: { opencode?: string; claude?: string };
  repos: Record<string, RepoConfig>;
  allowedSpaces: string[];
  contextFooter: ContextFooter;
  autoCompactAt: number;
}

export interface Thread {
  key: string;
  slug: string;
  repo?: string;
  branch?: string;
  updatedAt: string;
  context?: string;
  app: { running: boolean; port?: number };
}

export interface Agent {
  id: string;
  name: string;
  installed: boolean;
  version?: string;
  supported: boolean;
  ready?: boolean;
  detail?: string;
}

export interface Job {
  id: string;
  name: string;
  prompt: string;
  cron: string;
  when: string;
  space: string;
  repo?: string;
  enabled: boolean;
  createdBy: string;
  nextRunAt?: string;
  lastRunAt?: string;
  lastStatus?: "ok" | "failed" | "running";
  failures: number;
}

export interface Health {
  starts: number;
  crashes: number;
  supervised: boolean;
  startedAt: string;
  uptimeSec: number;
  lastBeatAgoSec: number;
  /** Public Chat endpoint through the tunnel, when the tunnel is on. */
  endpoint?: string;
}

export interface GoogleStatus {
  configured: boolean;
  source: "env" | "ui" | "none";
  clientEmail?: string;
  projectId?: string;
  endpoint?: string;
}

export type AdoStatus = { connected: false } | { connected: true; org: string; defaultProject?: string };

export interface AdoRepo {
  id: string;
  name: string;
}

async function call<T>(path: string, body?: unknown, method = body ? "POST" : "GET"): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data;
}

export const api = {
  settings: () => call<Settings>("/api/settings"),
  save: (patch: Partial<Settings>) => call<Settings>("/api/settings", patch, "PUT"),
  threads: () => call<Thread[]>("/api/threads"),
  logs: (slug: string) => call<{ logs: string }>(`/api/threads/logs?slug=${encodeURIComponent(slug)}`),
  stop: (slug: string) => call("/api/threads/down", { slug }),
  agents: () => call<Agent[]>("/api/agents"),
  models: () => call<string[]>("/api/agents/opencode/models"),
  health: () => call<Health>("/api/health"),
  playground: (thread: string, text: string) =>
    call<{ ok: boolean; replies: string[]; context?: string }>("/api/playground", { thread, text }),
  schedules: () => call<Job[]>("/api/schedules"),
  addSchedule: (job: { name?: string; prompt: string; cron: string; space: string; repo?: string }) => call<Job[]>("/api/schedules", job),
  updateSchedule: (id: string, patch: { enabled?: boolean }) => call<Job[]>("/api/schedules/update", { id, ...patch }),
  runSchedule: (id: string) => call<Job[]>("/api/schedules/run", { id }),
  deleteSchedule: (id: string) => call<Job[]>("/api/schedules/delete", { id }),
  google: () => call<GoogleStatus>("/api/google"),
  googleKey: (key: string) => call<GoogleStatus>("/api/google/key", { key }),
  googleClear: () => call<GoogleStatus>("/api/google/key/delete", {}),
  googleTest: (space: string) => call<GoogleStatus>("/api/google/test", { space }),
  adoStatus: () => call<AdoStatus>("/api/ado/status"),
  adoProjects: () => call<{ name: string }[]>("/api/ado/projects"),
  adoRepos: (project: string) => call<AdoRepo[]>(`/api/ado/repos?project=${encodeURIComponent(project)}`),
  adoClone: (project: string, repo: string) => call<Settings>("/api/ado/clone", { project, repo }),
};

export function ago(iso?: string): string {
  if (!iso) return "never";
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 0) return until(iso);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
}

export function until(iso?: string): string {
  if (!iso) return "—";
  const s = (new Date(iso).getTime() - Date.now()) / 1000;
  if (s <= 0) return "due now";
  if (s < 3600) return `in ${Math.ceil(s / 60)} min`;
  const d = new Date(iso);
  return d.toLocaleString(undefined, { weekday: "short", hour: "2-digit", minute: "2-digit" });
}

export function duration(sec: number): string {
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return d ? `${d} d ${h} h` : h ? `${h} h ${m} min` : `${m} min`;
}
