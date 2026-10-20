import { encodeJsonBody } from "./http-body";

export interface RepoConfig {
  path: string;
  up?: string;
  base?: string;
}

export type ContextFooter = "every" | "every5" | "above60" | "never";

export type TunnelMode = "auto" | "opentunnel" | "cloudflared" | "off";

export interface Settings {
  agentDriver: "pi";
  models: { pi?: string };
  repos: Record<string, RepoConfig>;
  allowedSpaces: string[];
  contextFooter: ContextFooter;
  autoCompactAt: number;
  debounceMs?: number;
  tunnel: TunnelMode;
  googleDriveFolderId?: string | null;
  mcpServers?: McpServer[];
  personas: Persona[];
  templates?: PersonaTemplate[];
  hostPrompt?: string | null;
  hostMcps?: string[] | null;
  hostSkills?: string[];
}

export const DEFAULT_HOST_MCPS = ["coding", "switchboard", "engram", "context7", "agents", "google-drive"];

export const DEFAULT_HOST_SKILLS = [
  "artifacts",
  "grill-with-docs",
  "domain-modeling",
  "tdd",
  "diagnosing-bugs",
  "codebase-design",
  "code-review",
  "improve-codebase-architecture",
  "retro",
  "teach",
  "writing-for-agents",
];

export interface PersonaAvatar {
  color: string;
  shape: "round" | "soft" | "tall" | "bean";
  expression: "idle" | "wink" | "happy" | "sleepy" | "curious";
}

export interface Persona {
  name: string;
  prompt: string;
  model?: string;
  listen?: "mentions" | "all";
  respondTo?: "anyone" | "people";
  skills?: string[];
  mcps?: string[];
  delegates?: string[];
  /** Custom blob avatar (color / shape / expression). */
  avatar?: PersonaAvatar;
}

export interface PersonaTemplate extends Persona {
  id: string;
}

export interface McpServer {
  name: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
}

export interface PiKey {
  provider: string;
  label: string;
  envVar: string;
  source: "settings" | "env" | "none";
}

export interface PiCustomProvider {
  id: string;
  name: string;
  baseUrl: string;
  models: string[];
  apiKeyEnv: string;
  contextWindow: number;
  maxTokens: number;
  keySource: "settings" | "env" | "none";
}

export type PiCustomProviderInput = {
  id: string;
  name?: string;
  baseUrl: string;
  models: string[];
  apiKey?: string;
  clearKey?: boolean;
  contextWindow?: number;
  maxTokens?: number;
};

export interface DriveMcpStatus {
  configured: boolean;
  connected: boolean;
  clientId?: string | null;
  redirectUri: string;
}

/** Bundled skill resource (Anthropic layout: references/, scripts/, assets/). */
export interface SkillFile {
  path: string;
  content: string;
}

export interface SkillInfo {
  name: string;
  description: string;
  mcps: string[];
  body: string;
  files?: SkillFile[];
}

/** Hit from skills.sh catalog search (proxied via /api/skills/search). */
export interface SkillSearchHit {
  name: string;
  skillId: string;
  source: string;
  installs: number;
}

export interface DraftChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface AgentDraftChatReply {
  message: string;
  draft?: Persona | null;
  ready: boolean;
}

export interface SkillDraftChatReply {
  message: string;
  draft?: SkillInfo | null;
  ready: boolean;
}

export interface HostDraft {
  prompt: string;
  mcps?: string[];
  skills?: string[];
}

export interface HostDraftChatReply {
  message: string;
  draft?: HostDraft | null;
  ready: boolean;
}

export const BUILTIN_MCPS = [
  { name: "coding", label: "Code — read, write, edit files and run commands" },
  { name: "agents", label: "Ask other agents — delegate a question to a specialist" },
  { name: "switchboard", label: "Switchboard — repos, schedules, artifacts, work item, room" },
  { name: "google-drive", label: "Google Drive — .xlsx in the shared folder, plus Google's Drive MCP" },
  { name: "google-calendar", label: "Google Calendar — list and manage events (remote MCP)" },
  { name: "google-gmail", label: "Gmail — search threads and create drafts (remote MCP)" },
];

export const DEFAULT_PERSONA_MCPS = ["engram", "context7"];

export interface SearchHit {
  threadKey: string;
  title: string;
  author: string;
  at?: string | null;
  snippet: string;
  href: string;
}

export interface ActivityEvent {
  id: string;
  at: string;
  kind: string;
  threadKey: string;
  title: string;
  detail: string;
  href: string;
}

export interface Thread {
  key: string;
  slug: string;
  repo?: string;
  branch?: string;
  updatedAt: string;
  context?: string;
  app: { running: boolean; port?: number };
  members?: string[];
  title?: string | null;
  driver?: "pi" | null;
  model?: string | null;
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
  lastStatus?: "ok" | "failed" | "running" | "pending" | "approved" | "denied";
  failures: number;
  trigger: JobTrigger;
  command?: string;
  pattern?: string;
  needsApproval: boolean;
  pending?: { id: string; at: string; reason: string } | null;
}

export type JobTrigger = "cron" | "command" | "mention";

export interface Approval {
  id: string;
  at: string;
  reason: string;
  jobId: string;
  name: string;
  prompt: string;
}

export interface ScheduleLogMessage {
  author: string;
  text: string;
  bot: boolean;
  at?: string;
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

export type AdoStatus =
  | { connected: false; hasEnvPat?: boolean }
  | {
      connected: true;
      org: string;
      defaultProject?: string;
      source?: "settings" | "cli" | "env" | string;
      hasEnvPat?: boolean;
    };

export interface AdoRepo {
  id: string;
  name: string;
}

async function call<T>(path: string, body?: unknown, method = body ? "POST" : "GET"): Promise<T> {
  const encoded = body !== undefined ? await encodeJsonBody(body) : undefined;
  const res = await fetch(path, {
    method,
    headers: encoded?.headers,
    body: encoded?.body,
  });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data;
}

export const api = {
  settings: () => call<Settings>("/api/settings"),
  save: (patch: Partial<Settings>) => call<Settings>("/api/settings", patch, "PUT"),
  threads: () => call<Thread[]>("/api/threads"),
  skills: () => call<SkillInfo[]>("/api/skills"),
  saveSkill: (skill: SkillInfo) => call<SkillInfo[]>("/api/skills", skill, "PUT"),
  deleteSkill: (name: string) => call<SkillInfo[]>(`/api/skills?name=${encodeURIComponent(name)}`, undefined, "DELETE"),
  installSkill: (source: string) => call<{ installed: string[]; skills: SkillInfo[] }>("/api/skills/install", { source }),
  searchSkills: (q: string, opts?: { owner?: string; limit?: number }) => {
    const params = new URLSearchParams({ q, limit: String(opts?.limit ?? 12) });
    const owner = opts?.owner?.trim();
    if (owner) params.set("owner", owner);
    return call<{ skills: SkillSearchHit[] }>(`/api/skills/search?${params}`);
  },
  draftAgent: (brief: string, current?: Persona) => call<Persona>("/api/ai/draft-agent", { brief, current }),
  draftSkill: (brief: string, current?: SkillInfo) => call<SkillInfo>("/api/ai/draft-skill", { brief, current }),
  draftAgentChat: (messages: DraftChatMessage[], current?: Persona) =>
    call<AgentDraftChatReply>("/api/ai/draft-agent/chat", { messages, current }),
  draftSkillChat: (messages: DraftChatMessage[], current?: SkillInfo) =>
    call<SkillDraftChatReply>("/api/ai/draft-skill/chat", { messages, current }),
  draftHostChat: (messages: DraftChatMessage[], current?: HostDraft) =>
    call<HostDraftChatReply>("/api/ai/draft-host/chat", { messages, current }),
  importMcp: (json: string) => call<{ imported: string[]; skipped: string[]; settings: Settings }>("/api/mcp/import", { json }),
  piKeys: () => call<PiKey[]>("/api/pi/keys"),
  setPiKey: (provider: string, key: string) => call<PiKey[]>("/api/pi/keys", { provider, key }),
  piCustomProviders: () => call<PiCustomProvider[]>("/api/pi/custom-providers"),
  savePiCustomProvider: (provider: PiCustomProviderInput) => call<PiCustomProvider[]>("/api/pi/custom-providers", provider),
  deletePiCustomProvider: (id: string) => call<PiCustomProvider[]>(`/api/pi/custom-providers?id=${encodeURIComponent(id)}`, undefined, "DELETE"),
  search: (q: string) => call<SearchHit[]>(`/api/search?q=${encodeURIComponent(q)}`),
  activity: (limit = 50) => call<ActivityEvent[]>(`/api/activity?limit=${limit}`),
  logs: (slug: string) => call<{ logs: string }>(`/api/threads/logs?slug=${encodeURIComponent(slug)}`),
  stop: (slug: string) => call("/api/threads/down", { slug }),
  agents: () => call<Agent[]>("/api/agents"),
  models: (refresh = false) => call<string[]>(`/api/agents/pi/models${refresh ? "?refresh=1" : ""}`),
  health: () => call<Health>("/api/health"),
  share: () => call<{ link: string }>("/api/share"),
  rotateShare: () => call<{ link: string }>("/api/share/rotate", {}),
  schedules: () => call<Job[]>("/api/schedules"),
  addSchedule: (job: { name?: string; prompt: string; cron: string; space: string; repo?: string; trigger?: JobTrigger; command?: string; pattern?: string; needsApproval?: boolean }) =>
    call<Job[]>("/api/schedules", job),
  approvals: () => call<Approval[]>("/api/approvals"),
  decideApproval: (id: string, approve: boolean) => call<Job>("/api/approvals/decide", { id, approve }),
  suggestSchedule: (text: string) => call<{ name: string; prompt: string; cron: string; when: string }>("/api/schedules/suggest", { text }),
  updateSchedule: (id: string, patch: { enabled?: boolean }) => call<Job[]>("/api/schedules/update", { id, ...patch }),
  runSchedule: (id: string) => call<Job[]>("/api/schedules/run", { id }),
  deleteSchedule: (id: string) => call<Job[]>("/api/schedules/delete", { id }),
  scheduleLog: (id: string) => call<{ messages: ScheduleLogMessage[] }>(`/api/schedules/log?id=${encodeURIComponent(id)}`),
  google: () => call<GoogleStatus>("/api/google"),
  googleKey: (key: string) => call<GoogleStatus>("/api/google/key", { key }),
  googleClear: () => call<GoogleStatus>("/api/google/key/delete", {}),
  googleTest: (space: string) => call<GoogleStatus>("/api/google/test", { space }),
  driveMcp: () => call<DriveMcpStatus>("/api/google/drive-mcp"),
  driveMcpSave: (clientId: string, clientSecret: string) => call<DriveMcpStatus>("/api/google/drive-mcp", { clientId, clientSecret }),
  driveMcpStart: () => call<{ url: string }>("/api/google/drive-mcp/start", {}),
  driveMcpClear: () => call<DriveMcpStatus>("/api/google/drive-mcp/delete", {}),
  calendarMcp: () => call<DriveMcpStatus>("/api/google/calendar-mcp"),
  calendarMcpSave: (clientId: string, clientSecret: string) =>
    call<DriveMcpStatus>("/api/google/calendar-mcp", { clientId, clientSecret }),
  calendarMcpStart: () => call<{ url: string }>("/api/google/calendar-mcp/start", {}),
  calendarMcpClear: () => call<DriveMcpStatus>("/api/google/calendar-mcp/delete", {}),
  gmailMcp: () => call<DriveMcpStatus>("/api/google/gmail-mcp"),
  gmailMcpSave: (clientId: string, clientSecret: string) =>
    call<DriveMcpStatus>("/api/google/gmail-mcp", { clientId, clientSecret }),
  gmailMcpStart: () => call<{ url: string }>("/api/google/gmail-mcp/start", {}),
  gmailMcpClear: () => call<DriveMcpStatus>("/api/google/gmail-mcp/delete", {}),
  adoStatus: () => call<AdoStatus>("/api/ado/status"),
  adoSave: (org: string, pat: string, defaultProject?: string) =>
    call<AdoStatus>("/api/ado", { org, pat, defaultProject: defaultProject || undefined }),
  adoClear: () => call<AdoStatus>("/api/ado/delete", {}),
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

// --- team chat: one UI, two transports (owner on the control plane, guests on the public link) ---

export interface AgentQuestion {
  header: string;
  question: string;
  options: { label: string; description?: string }[];
  multiple?: boolean;
}

export interface MessageAttachment {
  id: string;
  contentType: string;
  name?: string;
}

export interface TeamMessage {
  author: string;
  text: string;
  bot: boolean;
  at?: string;
  questions?: AgentQuestion[];
  attachments?: MessageAttachment[];
}

export interface TeamAttachmentInput {
  contentType: string;
  data: string;
  name?: string;
}

export interface TeamThreadWorkItem {
  id: number;
  title?: string;
  state?: string;
  type?: string;
  url?: string;
}

export interface TeamThreadChanges {
  clean: boolean;
  staged: number;
  unstaged: number;
  untracked: number;
  files: { path: string; status: string }[];
}

export interface AgentRun {
  name: string;
  role: "host" | "agent";
  driver?: string | null;
  model?: string | null;
  session?: string | null;
  contextTokens?: number | null;
  contextWindow?: number | null;
  turns?: number | null;
  estimated?: boolean | null;
}

export interface TeamThreadState {
  messages: TeamMessage[];
  agent: "pi" | null;
  model?: string | null;
  repo?: string | null;
  branch?: string | null;
  title?: string | null;
  worktree?: string | null;
  context?: string | null;
  app?: { running: boolean; port?: number };
  workItem?: TeamThreadWorkItem | null;
  changes?: TeamThreadChanges | null;
  busy: boolean;
  /** null = legacy room: every catalog agent is available. */
  members?: RoomMember[] | null;
  kicked?: string[];
  answering?: string[];
  presence?: Presence[];
  runs?: AgentRun[];
}

export interface Presence {
  id: string;
  name: string;
  status: "speaking" | "waiting" | "idle";
  lastSeenN?: number | null;
}

export type RoomMember =
  | { kind: "human"; id: string; name: string; joinedAt: string }
  | { kind: "agent"; id: string; persona: string; joinedAt: string };

export type MemberChange = { kind: "agent"; persona: string } | { kind: "human"; name: string };

export interface TeamThreadSummary {
  id: string;
  title: string;
  updatedAt?: string;
  count: number;
}

export interface TeamTransport {
  guest: boolean;
  /** Active (or archived) team threads on this machine. */
  threads?: (archived?: boolean) => Promise<TeamThreadSummary[]>;
  /** Owner only. */
  archive?: (id: string, archived: boolean) => Promise<unknown>;
  remove?: (id: string) => Promise<{ branchKept?: string }>;
  thread: (id: string) => Promise<TeamThreadState>;
  send: (id: string, text: string, name: string, attachments?: TeamAttachmentInput[]) => Promise<{ ok: boolean; replies: string[] }>;
  agents: () => Promise<{ id: string; name: string; ready?: boolean }[]>;
  /** Agents you can @mention in chat (names without @). */
  personas?: () => Promise<{ name: string; avatar?: PersonaAvatar }[]>;
  /** Absolute or same-origin URL for a saved attachment id. */
  mediaUrl: (id: string) => string;
  /** Stops agents talking among themselves in this thread after the current turn. */
  stopAgents: (id: string) => Promise<unknown>;
  /** Owner only: add or remove a room member. */
  members?: (id: string, op: "add" | "remove", member: MemberChange) => Promise<{ members: RoomMember[] }>;
}

export const ownerTransport: TeamTransport = {
  guest: false,
  threads: (archived = false) => call<TeamThreadSummary[]>(`/api/team/threads${archived ? "?archived=1" : ""}`),
  archive: (id, archived) => call("/api/team/archive", { thread: id, archived }),
  remove: (id) => call<{ branchKept?: string }>("/api/team/delete", { thread: id }),
  thread: (id) => call<TeamThreadState>(`/api/team/thread?thread=${encodeURIComponent(id)}`),
  send: (id, text, name, attachments) => call("/api/team/send", { thread: id, text, name, ...(attachments?.length && { attachments }) }),
  agents: () => call<Agent[]>("/api/agents").then((list) => list.filter((a) => a.supported && a.installed)),
  personas: () =>
    call<Settings>("/api/settings").then((s) =>
      (s.personas ?? []).map((p) => ({ name: p.name, ...(p.avatar ? { avatar: p.avatar } : {}) })),
    ),
  mediaUrl: (id) => `/api/media/${id}`,
  stopAgents: (id) => call("/api/team/stop", { thread: id }),
  members: (id, op, member) => call("/api/team/members", { thread: id, op, member }),
};

export function guestTransport(token: string): TeamTransport {
  const req = async <T,>(path: string, body?: unknown): Promise<T> => {
    const encoded = body !== undefined ? await encodeJsonBody(body) : undefined;
    const res = await fetch(path, {
      method: body !== undefined ? "POST" : "GET",
      headers: { authorization: `Bearer ${token}`, ...encoded?.headers },
      body: encoded?.body,
    });
    const data = (await res.json().catch(() => ({}))) as T & { error?: string };
    if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
    return data;
  };
  return {
    guest: true,
    threads: (archived = false) => req<TeamThreadSummary[]>(`/play/api/threads${archived ? "?archived=1" : ""}`),
    thread: (id) => req<TeamThreadState>(`/play/api/thread?thread=${encodeURIComponent(id)}`),
    send: (id, text, name, attachments) => req("/play/api/send", { thread: id, text, name, ...(attachments?.length && { attachments }) }),
    agents: () => req("/play/api/agents"),
    personas: () => req("/play/api/personas"),
    mediaUrl: (id) => `/play/api/media/${id}?access=${encodeURIComponent(token)}`,
    stopAgents: (id) => req("/play/api/stop", { thread: id }),
  };
}
