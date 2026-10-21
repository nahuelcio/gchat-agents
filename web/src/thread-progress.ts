import type { QueuedItem } from "./api";

export type ThreadViewState = { readonly docs: Readonly<Record<string, unknown>>; readonly entries?: readonly { model?: readonly Message[] }[] };

export type ToolLine = { callId?: string; text: string; running: boolean };
export type Progress = { thinking: string; tools: ToolLine[]; tps?: number; queued: QueuedItem[] };

type Args = Record<string, unknown>;
type Block = { type?: string; id?: string; thinking?: string; text?: string; arguments?: Args };
type Message = { content?: Block[]; usage?: { output?: number } };
type Slot = { callId: string; name: string; status: "pending" | "running" | "done"; parentCallId?: string; arguments?: Args };
type Live = { run?: unknown; generation?: { message?: Message }; tools?: Slot[]; nestedTools?: Slot[] };
type Inbox = { items?: { id: string; mode: string; content?: unknown }[] };

const describe = (args: Args | undefined): string => (args && Object.keys(args).length > 0 ? JSON.stringify(args) : "");

const textOf = (content: unknown): string =>
  typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content.map((part) => (part as { text?: string }).text ?? "").join("")
      : "";

export function progressOf(view: ThreadViewState | undefined, startedAt?: number, now = Date.now()): Progress {
  const live = (view?.docs["pi.live"] ?? {}) as Live;
  const message = live.generation?.message;
  const blocks = message?.content ?? [];
  const calls = new Map<string, Args>();
  const recent = (view?.entries ?? []).slice(-8).flatMap((entry) => (entry.model ?? []).flatMap((m) => m.content ?? []));
  for (const block of [...recent, ...blocks]) if (block.type === "toolCall" && block.id) calls.set(block.id, block.arguments ?? {});
  const tools = [...(live.tools ?? []), ...(live.nestedTools ?? [])].map((slot) => {
    const args = describe(slot.arguments ?? calls.get(slot.callId));
    return {
      callId: slot.callId,
      text: `${slot.parentCallId ? "↳ " : ""}${slot.name}${args ? `: ${args}` : ""}`,
      running: slot.status !== "done",
    };
  });
  const output = message?.usage?.output ?? 0;
  const seconds = startedAt === undefined ? 0 : (now - startedAt) / 1000;
  const tps = output > 0 && seconds > 0 ? Math.round((output / seconds) * 10) / 10 : undefined;
  const inbox = (view?.docs["pi.inbox"] ?? {}) as Inbox;
  const queued = (inbox.items ?? []).flatMap((item): QueuedItem[] =>
    item.mode === "steer" || item.mode === "followUp" ? [{ id: item.id, mode: item.mode, text: textOf(item.content) }] : [],
  );
  return {
    thinking: blocks.filter((block) => block.type === "thinking").map((block) => block.thinking ?? "").join(""),
    tools,
    ...(tps !== undefined && { tps }),
    queued,
  };
}

export type TurnLog = Progress & { segments: string[]; open: boolean };

export function accumulate(prev: TurnLog | undefined, next: Progress): TurnLog {
  const segments = [...(prev?.segments ?? [])];
  let open = prev?.open ?? false;
  if (next.thinking) {
    if (open) segments[segments.length - 1] = next.thinking;
    else segments.push(next.thinking);
    open = true;
  } else {
    open = false;
  }
  const tools = [...(prev?.tools ?? [])];
  for (const tool of next.tools) {
    const at = tools.findIndex((t) => t.callId === tool.callId);
    if (at >= 0) tools[at] = tool;
    else tools.push(tool);
  }
  return { ...next, thinking: segments.join("\n\n"), tools, segments, open };
}
