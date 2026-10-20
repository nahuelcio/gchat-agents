import type { AgentEvent } from "@earendil-works/pi-durable";

/**
 * One line of live progress, forwarded verbatim to the web UI. Thinking reaches the client whole —
 * as deltas or as whatever whole-block shape a collapsed batch carries — under a collapsed disclosure.
 */
export type ProgressItem =
  | { kind: "turn"; text: "" }
  | { kind: "thinking"; text: string }
  | { kind: "tool"; text: string; callId?: string }
  | { kind: "tool_done"; text: string; callId?: string }
  | { kind: "idle"; text: "" };

/** Tool arguments as the model sent them; the UI decides how much of it to show. */
function describe(args: Record<string, unknown> | undefined): string {
  if (!args || Object.keys(args).length === 0) return "";
  return JSON.stringify(args);
}

const THROTTLE_MS = 300;

const thinkingOf = (block: { type: string; thinking?: string } | undefined): string | undefined =>
  block?.type === "thinking" ? (block.thinking ?? "") : undefined;

/** Maps pi-durable agent events to progress lines. Thinking is coalesced per batch, never truncated. */
export function progressMapper(now: () => number = Date.now) {
  let pending = "";
  let sentAt = -Infinity;
  // Deltas are not the only shape a batch takes: pi-durable collapses writes into a whole block
  // (thinking_start/block) or a whole message, and a mapper that only reads thinking_delta loses
  // everything those shapes carry. Track the latest full thinking text per content index instead.
  const known = new Map<number, string>();
  const sent = new Map<number, number>();
  return (events: readonly AgentEvent[]): ProgressItem[] => {
    const out: ProgressItem[] = [];
    const flush = () => {
      if (pending) out.push({ kind: "thinking", text: pending });
      pending = "";
      sentAt = now();
    };
    /** Queue every not-yet-forwarded suffix; a collapsed batch backfills what deltas missed. */
    const drain = (changes: readonly { type: string; contentIndex?: number; delta?: string; block?: { type: string; thinking?: string }; message?: { content?: { type: string; thinking?: string }[] } }[]) => {
      for (const c of changes) {
        if (c.type === "thinking_delta") known.set(c.contentIndex ?? 0, (known.get(c.contentIndex ?? 0) ?? "") + (c.delta ?? ""));
        else if (c.type === "thinking_start" || c.type === "block") {
          const text = thinkingOf(c.block as { type: string; thinking?: string } | undefined);
          if (text !== undefined) known.set(c.contentIndex ?? 0, text);
        } else if (c.type === "message") {
          (c.message?.content ?? []).forEach((b: { type: string; thinking?: string }, i: number) => {
            const text = thinkingOf(b);
            if (text !== undefined) known.set(i, text);
          });
        }
      }
      for (const i of [...known.keys()].sort((a, b) => a - b)) {
        const text = known.get(i) ?? "";
        const sentLen = sent.get(i) ?? 0;
        if (text.length > sentLen) {
          pending += text.slice(sentLen);
          sent.set(i, text.length);
        }
      }
    };
    for (const e of events) {
      if (e.type === "message_update") {
        drain(e.changes as never);
        if (pending && now() - sentAt >= THROTTLE_MS) flush();
      } else if (e.type === "tool_execution_start") {
        flush();
        const args = describe(e.args);
        out.push({ kind: "tool", text: `${e.parentToolCallId ? "↳ " : ""}${e.toolName}${args ? `: ${args}` : ""}`, callId: e.toolCallId });
      } else if (e.type === "tool_execution_end") {
        flush();
        out.push({ kind: "tool_done", text: e.toolName, callId: e.toolCallId });
      } else if (e.type === "turn_start") {
        flush();
        out.push({ kind: "turn", text: "" });
      } else if (e.type === "run_end") {
        flush();
        out.push({ kind: "idle", text: "" });
      }
    }
    return out;
  };
}
