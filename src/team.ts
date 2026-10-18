import { contextLine, processMessage, type HandlerDeps } from "./handler.js";
import { answering, BOT_NAME, humanAskedFor, withAgent, withHuman } from "./personas.js";
import type { RoomMember } from "./store.js";
import { adoWorkItem, type AdoAuth, type AdoWorkItem, type FetchFn } from "./integrations.js";
import { attachmentPromptLine, toMessageAttachment, type MessageAttachment } from "./media.js";
import { cancelQuestion } from "./question-gate.js";
import type { TranscriptStore } from "./transcripts.js";
import { workItemFromBranch } from "./work-item.js";
import { threadSlug, type GitChangeSummary } from "./workspace.js";

export { workItemFromBranch } from "./work-item.js";

/** Team chat threads live under this key prefix (sessions, transcripts). */
export const TEAM_PREFIX = "share/";
export const THREAD_ID = /^[\w-]{8,40}$/;

const MAX_ATTACHMENTS = 5;
const MAX_ATTACHMENT_BYTES = 3_500_000;

export interface TeamAttachmentInput {
  contentType: string;
  data: string;
  name?: string;
}

/** Decodes base64 team-chat uploads into the media store (images only). */
export async function saveTeamAttachments(
  deps: HandlerDeps,
  inputs: TeamAttachmentInput[] | undefined,
): Promise<{ stored: MessageAttachment[]; promptLines: string[] }> {
  if (!inputs?.length) return { stored: [], promptLines: [] };
  if (!deps.media) throw new Error("media store unavailable");
  if (inputs.length > MAX_ATTACHMENTS) throw new Error(`at most ${MAX_ATTACHMENTS} attachments`);
  const stored: MessageAttachment[] = [];
  const promptLines: string[] = [];
  for (const raw of inputs) {
    const contentType = raw.contentType?.trim() || "";
    if (!contentType.startsWith("image/")) throw new Error("only image attachments are supported");
    let bytes: Buffer;
    try {
      bytes = Buffer.from(raw.data, "base64");
    } catch {
      throw new Error("invalid attachment data");
    }
    if (!bytes.length || bytes.length > MAX_ATTACHMENT_BYTES) {
      throw new Error(`each image must be between 1 byte and ${MAX_ATTACHMENT_BYTES} bytes`);
    }
    const saved = await deps.media.save(bytes, contentType, raw.name?.trim() || undefined);
    stored.push(toMessageAttachment(saved));
    promptLines.push(attachmentPromptLine(saved));
  }
  return { stored, promptLines };
}

/**
 * One team-chat message: recorded first (teammates polling see it right away),
 * then the agent turn runs in the background on the thread queue — same pattern
 * as Google Chat, so the sender can keep chatting while Switchboard works.
 */
export async function teamSend(
  deps: HandlerDeps,
  transcripts: TranscriptStore,
  req: {
    thread: string;
    text: string;
    name: string;
    allowCommands?: ReadonlySet<string>;
    attachments?: TeamAttachmentInput[];
  },
): Promise<{ ok: boolean; replies: string[] }> {
  const threadKey = `${TEAM_PREFIX}${req.thread}`;
  const { stored, promptLines } = await saveTeamAttachments(deps, req.attachments);
  const text = req.text.trim();
  const prompt = [text, ...promptLines].filter(Boolean).join("\n\n");
  if (!prompt) throw new Error("text or an image is required");
  await transcripts.append(threadKey, [
    {
      author: req.name,
      text: text || (stored.length ? "(image)" : ""),
      bot: false,
      ...(stored.length && { attachments: stored }),
    },
  ]);
  // Whoever writes joins the room; a brand-new room starts with no agents (the owner adds them).
  const record = deps.store.get(threadKey);
  if (!record || record.members) {
    await deps.store.update(threadKey, "team-chat", { members: withHuman(record?.members ?? [], req.name) });
  }
  // Kick off the turn without awaiting: HTTP returns once the message is stored.
  // processMessage registers on the queue synchronously, so busy() is true immediately.
  void processMessage(
    {
      threadKey,
      spaceName: "team-chat",
      text: prompt,
      sender: req.name,
      reply: async (r, meta) => {
        await transcripts.append(threadKey, [{ author: meta?.author ? `@${meta.author}` : BOT_NAME, text: r, bot: true, ...(meta?.questions && { questions: meta.questions }) }]);
      },
      ...(req.allowCommands && { allowCommands: req.allowCommands }),
    },
    deps,
  ).catch((err: unknown) => {
    console.error(`[team ${threadKey}] background turn failed:`, err);
  });
  return { ok: true, replies: [] };
}

export interface TeamThreadWorkItem {
  id: number;
  title?: string;
  state?: string;
  type?: string;
  url?: string;
}

export interface TeamThreadContext {
  messages: ReturnType<TranscriptStore["get"]>;
  agent: "pi" | null;
  model?: string | null;
  repo?: string | null;
  branch?: string | null;
  worktree?: string | null;
  context?: string | null;
  app?: { running: boolean; port?: number };
  workItem?: TeamThreadWorkItem | null;
  changes?: GitChangeSummary | null;
  busy: boolean;
  /** Room members; null = legacy room where every catalog agent is available. */
  members: RoomMember[] | null;
  kicked: string[];
  answering: string[];
}

export interface TeamThreadExtras {
  ado?: AdoAuth;
  fetch?: FetchFn;
}

/** History + live state of one team thread, for the chat view (incl. side panel). */
export async function teamThread(
  deps: HandlerDeps,
  transcripts: TranscriptStore,
  thread: string,
  extras: TeamThreadExtras = {},
): Promise<TeamThreadContext> {
  const threadKey = `${TEAM_PREFIX}${thread}`;
  const record = deps.store.get(threadKey);
  const options = deps.options?.();
  const slug = threadSlug(threadKey);
  const ws = deps.workspaces;
  const workItemId = record?.workItemId ?? workItemFromBranch(record?.branch);
  let workItem: TeamThreadWorkItem | null = workItemId ? { id: workItemId } : null;
  if (workItemId && extras.ado) {
    try {
      const wi: AdoWorkItem = await adoWorkItem(extras.ado, workItemId, extras.fetch);
      workItem = { id: wi.id, title: wi.title, state: wi.state, type: wi.type, url: wi.url };
    } catch {
      // Keep the bare id when Azure is unreachable or the item is gone.
    }
  }
  const changes = record?.worktree && ws ? await ws.changes(record.worktree) : null;
  return {
    messages: transcripts.get(threadKey),
    agent: record?.driver ?? null,
    model: record?.model ?? null,
    repo: record?.repo ?? null,
    branch: record?.branch ?? null,
    worktree: record?.worktree ?? null,
    context: record && options ? contextLine(record, options).slice(2) : null,
    app: { running: ws?.isUp(slug) ?? false, ...(ws?.port(slug) !== undefined && { port: ws.port(slug) }) },
    workItem,
    changes,
    busy: deps.queue.busy(threadKey),
    members: record?.members ?? null,
    kicked: record?.kicked ?? [],
    answering: answering(threadKey),
  };
}

/** Owner: adds or removes a catalog agent (or removes a human) from a room. */
export async function teamMembers(
  deps: HandlerDeps,
  thread: string,
  op: "add" | "remove",
  member: { kind: "agent"; persona: string } | { kind: "human"; name: string },
): Promise<RoomMember[]> {
  const threadKey = `${TEAM_PREFIX}${thread}`;
  const catalog = deps.options?.().personas ?? [];
  const record = deps.store.get(threadKey);
  // A legacy room gets an explicit list on first edit: its current humans are unknown, agents start from the whole catalog.
  let members = record?.members ?? (record ? catalog.reduce((m, p) => withAgent(m, p.name), [] as RoomMember[]) : []);
  if (member.kind === "agent") {
    const persona = catalog.find((p) => p.name.toLowerCase() === member.persona.replace(/^@/, "").toLowerCase());
    if (!persona) throw new Error(`no agent @${member.persona} — add it under Create`);
    const id = `agent:${persona.name.toLowerCase()}`;
    members = op === "add" ? withAgent(members, persona.name) : members.filter((m) => m.id !== id);
    const kicked = (record?.kicked ?? []).filter((n) => n.toLowerCase() !== persona.name.toLowerCase());
    await deps.store.update(threadKey, record?.space ?? "team-chat", { kicked: op === "remove" ? [...kicked, persona.name] : kicked });
  } else {
    const id = `human:${member.name.trim().toLowerCase()}`;
    members = op === "add" ? withHuman(members, member.name) : members.filter((m) => m.id !== id);
  }
  await deps.store.update(threadKey, record?.space ?? "team-chat", { members });
  return members;
}

/**
 * Deletes a team thread: history, agent session, and its worktree (app stopped).
 * The branch stays in the repo so no commit is lost. Queued on the thread so a
 * running turn finishes first instead of re-creating the record afterwards.
 */
export function teamDelete(deps: HandlerDeps, transcripts: TranscriptStore, thread: string): Promise<{ branchKept?: string }> {
  const threadKey = `${TEAM_PREFIX}${thread}`;
  return deps.queue.run(threadKey, async () => {
    cancelQuestion(threadKey);
    const record = deps.store.get(threadKey);
    if (record?.worktree && record.repo && deps.workspaces) {
      deps.workspaces.down(threadSlug(threadKey));
      await deps.workspaces.remove(record.repo, record.worktree).catch((err: unknown) => {
        console.error(`[team ${thread}] worktree removal failed:`, err);
      });
    }
    await deps.store.delete(threadKey);
    await transcripts.remove(threadKey);
    return record?.branch ? { branchKept: record.branch } : {};
  });
}

export async function teamInvite(deps: HandlerDeps, threadKey: string, name: string): Promise<RoomMember[]> {
  const room = threadKey.split("#")[0]!;
  const record = deps.store.get(room);
  const persona = name.replace(/^@/, "");
  if (!record?.members) throw new Error("this chat has no member list: every agent is already available");
  if (!humanAskedFor(record.room, persona)) throw new Error(`only a person can bring @${persona} into the room: ask them to request it`);
  if (!room.startsWith(TEAM_PREFIX)) throw new Error("agents can only be invited to team chat rooms");
  return teamMembers(deps, room.slice(TEAM_PREFIX.length), "add", { kind: "agent", persona });
}
