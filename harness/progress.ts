import type { AgentEvent } from "@earendil-works/pi-durable";

export type ProgressItem = { kind: "thinking" | "tool" | "tool_done" | "idle"; text: string };

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

function preview(args: Record<string, unknown> | undefined): string {
  if (!args || Object.keys(args).length === 0) return "";
  const main = args.command ?? args.code ?? args.path;
  return clip(typeof main === "string" ? main.replace(/\s+/g, " ") : JSON.stringify(args), 120);
}

/** Maps pi-durable agent events to compact progress lines; thinking is coalesced to a 200-char tail at most every 300ms. */
export function progressMapper(now: () => number = Date.now) {
  let thinking = "";
  let pending = false;
  let sentAt = -Infinity;
  return (events: readonly AgentEvent[]): ProgressItem[] => {
    const out: ProgressItem[] = [];
    const flush = () => {
      if (pending) out.push({ kind: "thinking", text: thinking });
      pending = false;
      sentAt = now();
    };
    for (const e of events) {
      if (e.type === "message_update") {
        for (const c of e.changes) {
          if (c.type !== "thinking_delta") continue;
          thinking = (thinking + c.delta).slice(-200);
          pending = true;
        }
        if (pending && now() - sentAt >= 300) flush();
      } else if (e.type === "tool_execution_start") {
        flush();
        const args = preview(e.args);
        out.push({ kind: "tool", text: `${e.parentToolCallId ? "↳ " : ""}${e.toolName}${args ? `: ${args}` : ""}` });
      } else if (e.type === "tool_execution_end") {
        flush();
        out.push({ kind: "tool_done", text: e.toolName });
      } else if (e.type === "run_end") {
        flush();
        thinking = "";
        out.push({ kind: "idle", text: "" });
      } else if (e.type === "turn_start") {
        thinking = "";
      }
    }
    return out;
  };
}
