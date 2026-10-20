import type { AgentEvent } from "@earendil-works/pi-durable";

/**
 * One line of live progress, forwarded verbatim to the web UI. Thinking arrives as deltas so no
 * character is ever dropped: the client appends them under a collapsed disclosure.
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

/** Maps pi-durable agent events to progress lines. Thinking is coalesced per batch, never truncated. */
export function progressMapper(now: () => number = Date.now) {
  let pending = "";
  let sentAt = -Infinity;
  return (events: readonly AgentEvent[]): ProgressItem[] => {
    const out: ProgressItem[] = [];
    const flush = () => {
      if (pending) out.push({ kind: "thinking", text: pending });
      pending = "";
      sentAt = now();
    };
    for (const e of events) {
      if (e.type === "message_update") {
        for (const c of e.changes) if (c.type === "thinking_delta") pending += c.delta;
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
