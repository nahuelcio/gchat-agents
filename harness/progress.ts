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
  | { kind: "tps"; tps: number }
  | { kind: "idle"; text: "" };

/** Tool arguments as the model sent them; the UI decides how much of it to show. */
function describe(args: Record<string, unknown> | undefined): string {
  if (!args || Object.keys(args).length === 0) return "";
  return JSON.stringify(args);
}

const THROTTLE_MS = 300;
/** Generation rate window and emit spacing for the tok/s ticker. */
const RATE_WINDOW_MS = 5000;
const RATE_EMIT_MS = 700;
/** Rough token estimate for streamed text: ~4 characters per token. */
const CHARS_PER_TOKEN = 4;

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
  // Live generation rate: estimated from every streamed character; a final real rate lands with the
  // message's usage. Marks are (time, tokens-so-far) pairs pruned to the rate window.
  let genTokens = 0;
  let turnAt = 0;
  let inTurn = false;
  let lastTpsAt = -Infinity;
  const marks: [number, number][] = [];
  const emitTps = (out: ProgressItem[], rate: number) => {
    const tps = Math.round(rate * 10) / 10;
    if (tps > 0) out.push({ kind: "tps", tps });
    lastTpsAt = now();
  };
  /** Queue every not-yet-forwarded suffix; a collapsed batch backfills what deltas missed. Returns the characters generated. */
  const drain = (changes: readonly { type: string; contentIndex?: number; delta?: string; block?: { type: string; thinking?: string }; message?: { content?: { type: string; thinking?: string }[] } }[]): number => {
    let chars = 0;
    const grow = (index: number, full: string) => {
      const prev = known.get(index) ?? "";
      known.set(index, full);
      return Math.max(0, full.length - prev.length);
    };
    for (const c of changes) {
      if (c.type === "thinking_delta") {
        chars += (c.delta ?? "").length;
        known.set(c.contentIndex ?? 0, (known.get(c.contentIndex ?? 0) ?? "") + (c.delta ?? ""));
      } else if (c.type === "text_delta" || c.type === "toolcall_delta") {
        chars += (c.delta ?? "").length;
      } else if (c.type === "thinking_start" || c.type === "block") {
        const text = thinkingOf(c.block as { type: string; thinking?: string } | undefined);
        if (text !== undefined) chars += grow(c.contentIndex ?? 0, text);
      } else if (c.type === "message") {
        (c.message?.content ?? []).forEach((b: { type: string; thinking?: string }, i: number) => {
          const text = thinkingOf(b);
          if (text !== undefined) chars += grow(i, text);
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
    return chars;
  };
  /** Rate over the sliding window; emits at most one frame per RATE_EMIT_MS while tokens stream. */
  const tickRate = (out: ProgressItem[]) => {
    const t = now();
    marks.push([t, genTokens]);
    while (marks.length > 1 && t - marks[0]![0] > RATE_WINDOW_MS) marks.shift();
    const [first] = marks[0]!;
    const span = (t - first) / 1000;
    if (span >= 1.5 && t - lastTpsAt >= RATE_EMIT_MS) emitTps(out, (genTokens - marks[0]![1]) / span);
  };
  return (events: readonly AgentEvent[]): ProgressItem[] => {
    const out: ProgressItem[] = [];
    const flush = () => {
      if (pending) out.push({ kind: "thinking", text: pending });
      pending = "";
      sentAt = now();
    };
    for (const e of events) {
      if (e.type === "message_update") {
        genTokens += drain(e.changes as never) / CHARS_PER_TOKEN;
        if (pending && now() - sentAt >= THROTTLE_MS) flush();
        tickRate(out);
      } else if (e.type === "message_end") {
        // The final usage replaces the estimate with the provider's real average for the turn.
        const usage = (e.entry as { model?: { usage?: { output?: number } }[] } | undefined)?.model?.[0]?.usage;
        const seconds = inTurn ? (now() - turnAt) / 1000 : 0;
        if (usage?.output && seconds > 0) emitTps(out, usage.output / seconds);
      } else if (e.type === "tool_execution_start") {
        flush();
        const args = describe(e.args);
        out.push({ kind: "tool", text: `${e.parentToolCallId ? "↳ " : ""}${e.toolName}${args ? `: ${args}` : ""}`, callId: e.toolCallId });
      } else if (e.type === "tool_execution_end") {
        flush();
        out.push({ kind: "tool_done", text: e.toolName, callId: e.toolCallId });
      } else if (e.type === "turn_start") {
        flush();
        genTokens = 0;
        marks.length = 0;
        turnAt = now();
        inTurn = true;
        out.push({ kind: "turn", text: "" });
      } else if (e.type === "run_end") {
        flush();
        inTurn = false;
        out.push({ kind: "idle", text: "" });
      }
    }
    return out;
  };
}
