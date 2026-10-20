import { describe, expect, it } from "vitest";
import { progressMapper } from "../harness/progress.ts";

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
});
