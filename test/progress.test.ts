import { describe, expect, it } from "vitest";
import { progressMapper, snapshotEvents } from "../harness/progress.ts";

describe("progressMapper", () => {
  it("maps tool start/end, nested calls, and run end", () => {
    const map = progressMapper(() => 0);
    expect(
      map([
        { type: "tool_execution_start", toolCallId: "a", toolName: "bash", args: { command: "ls -la" } },
        { type: "tool_execution_start", toolCallId: "a/1", toolName: "engram__mem_search", parentToolCallId: "a", args: { query: "x" } },
        { type: "tool_execution_end", toolCallId: "a", toolName: "bash" },
        { type: "run_end", inputs: [] },
      ] as never),
    ).toEqual([
      { kind: "tool", text: 'bash: {"command":"ls -la"}', callId: "a" },
      { kind: "tool", text: '↳ engram__mem_search: {"query":"x"}', callId: "a/1" },
      { kind: "tool_done", text: "bash", callId: "a" },
      { kind: "idle", text: "" },
    ]);
  });

  it("sends thinking whole, throttled, never truncated", () => {
    let t = 0;
    const map = progressMapper(() => t);
    const think = (delta: string) => [{ type: "message_update", changes: [{ type: "thinking_delta", contentIndex: 0, delta }] }] as never;
    expect(map(think("hello "))).toEqual([{ kind: "thinking", text: "hello " }]);
    t = 100;
    expect(map(think("world"))).toEqual([]);
    t = 400;
    const long = "x".repeat(5000);
    expect(map(think(long))).toEqual([{ kind: "thinking", text: "world" + long }]);
  });

  it("backfills thinking that arrives collapsed into a whole block or message", () => {
    let t = 0;
    const map = progressMapper(() => t);
    expect(
      map([{ type: "message_update", changes: [{ type: "thinking_start", contentIndex: 0, block: { type: "thinking", thinking: "We need answer. " } }] }] as never),
    ).toEqual([{ kind: "thinking", text: "We need answer. " }]);
    t = 400;
    expect(
      map([{ type: "message_update", changes: [{ type: "thinking_delta", contentIndex: 0, delta: "more" }] }] as never),
    ).toEqual([{ kind: "thinking", text: "more" }]);
    t = 800;
    expect(
      map([{ type: "message_update", changes: [{ type: "message", message: { content: [{ type: "thinking", thinking: "We need answer. more text" }] } }] }] as never),
    ).toEqual([{ kind: "thinking", text: " text" }]);
  });

  it("never duplicates or truncates when a collapsed batch overlaps sent deltas", () => {
    let t = 0;
    const map = progressMapper(() => t);
    const think = (delta: string) => [{ type: "message_update", changes: [{ type: "thinking_delta", contentIndex: 0, delta }] }] as never;
    expect(map(think("abc"))).toEqual([{ kind: "thinking", text: "abc" }]);
    t = 400;
    expect(
      map([{ type: "message_update", changes: [{ type: "block", contentIndex: 0, block: { type: "thinking", thinking: "abcdef" } }] }] as never),
    ).toEqual([{ kind: "thinking", text: "def" }]);
    t = 800;
    expect(
      map([{ type: "message_update", changes: [{ type: "block", contentIndex: 0, block: { type: "thinking", thinking: "xy" } }] }] as never),
    ).toEqual([]);
  });

  it("keeps tool arguments whole", () => {
    const map = progressMapper(() => 0);
    const code = "console.log(1)".repeat(100);
    expect(map([{ type: "tool_execution_start", toolCallId: "c", toolName: "codemode", args: { code } }] as never)).toEqual([
      { kind: "tool", text: `codemode: ${JSON.stringify({ code })}`, callId: "c" },
    ]);
  });

  it("starts a turn and flushes pending thinking before a tool item", () => {
    let t = 0;
    const map = progressMapper(() => t);
    map([{ type: "message_update", changes: [{ type: "thinking_delta", contentIndex: 0, delta: "a" }] }] as never);
    t = 10;
    map([{ type: "message_update", changes: [{ type: "thinking_delta", contentIndex: 0, delta: "b" }] }] as never);
    expect(map([{ type: "tool_execution_start", toolCallId: "c", toolName: "codemode", args: {} }] as never)).toEqual([
      { kind: "thinking", text: "b" },
      { kind: "tool", text: "codemode", callId: "c" },
    ]);
    expect(map([{ type: "turn_start" }] as never)).toEqual([{ kind: "turn", text: "" }]);
  });

  it("emits an estimated tok/s while the model streams, resetting with the turn", () => {
    let t = 0;
    const map = progressMapper(() => t);
    const think = (delta: string) => [{ type: "message_update", changes: [{ type: "thinking_delta", contentIndex: 0, delta }] }] as never;
    const rates = (items: ReturnType<ReturnType<typeof progressMapper>>) => items.filter((i) => i.kind === "tps");
    expect(map([{ type: "turn_start" }] as never)).toEqual([{ kind: "turn", text: "" }]);
    t = 100;
    map(think("x".repeat(40)));
    t = 1300;
    expect(rates(map(think("x".repeat(40))))).toEqual([]);
    t = 1700;
    expect(rates(map(think("x".repeat(40))))).toEqual([{ kind: "tps", tps: 12.5 }]);
    t = 2000;
    expect(rates(map(think("x".repeat(40))))).toEqual([]);
  });

  it("emits the real average tok/s from the final usage", () => {
    let t = 0;
    const map = progressMapper(() => t);
    map([{ type: "turn_start" }] as never);
    t = 4000;
    expect(map([{ type: "message_end", entry: { model: [{ usage: { output: 120 } }] } }] as never)).toEqual([
      { kind: "tps", tps: 30 },
    ]);
  });

  it("rebuilds a running turn from the snapshot, then follows the live stream", () => {
    let t = 0;
    const map = progressMapper(() => t);
    const snapshot = {
      type: "snapshot",
      entries: [{ kind: "assistant", model: [{ role: "assistant", content: [{ type: "toolCall", id: "a", name: "bash", arguments: { command: "ls" } }] }] }],
      run: { inputs: [] },
      generation: { attempt: 1, message: { role: "assistant", content: [{ type: "thinking", thinking: "hmm" }], usage: { output: 1 } } },
      tools: [
        { callId: "a", name: "bash", status: "running" },
        { callId: "b", name: "read", status: "done" },
      ],
      nestedTools: [],
      compactions: [],
      inbox: [],
      agent: {},
      usage: {},
    };
    expect(map(snapshotEvents(snapshot as never))).toEqual([
      { kind: "turn", text: "" },
      { kind: "thinking", text: "hmm" },
      { kind: "tool", text: 'bash: {"command":"ls"}', callId: "a" },
      { kind: "tool", text: "read", callId: "b" },
      { kind: "tool_done", text: "read", callId: "b" },
    ]);
    t = 400;
    expect(map([{ type: "message_update", changes: [{ type: "thinking_delta", contentIndex: 0, delta: " ok" }] }] as never)).toEqual([
      { kind: "thinking", text: " ok" },
    ]);
    expect(map([{ type: "tool_execution_end", toolCallId: "a", toolName: "bash" }] as never)).toEqual([
      { kind: "tool_done", text: "bash", callId: "a" },
    ]);
  });
});
