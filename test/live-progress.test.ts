import { describe, expect, it } from "vitest";
import { applyProgress, emptyProgress, type Progress } from "../web/src/live-progress.ts";

const fold = (events: Parameters<typeof applyProgress>[1][]) =>
  events.reduce<Progress>(applyProgress, emptyProgress);

describe("applyProgress", () => {
  it("appends thinking whole and resets it on a new turn", () => {
    expect(
      fold([
        { kind: "turn" },
        { kind: "thinking", text: "a".repeat(4000) },
        { kind: "thinking", text: "b" },
      ]).thinking,
    ).toBe("a".repeat(4000) + "b");
    expect(fold([{ kind: "thinking", text: "x" }, { kind: "turn" }]).thinking).toBe("");
  });

  it("marks the matching tool call done, newest first", () => {
    const state = fold([
      { kind: "tool", text: "bash: ls", callId: "a" },
      { kind: "tool", text: "codemode: {} ", callId: "b" },
      { kind: "tool_done", text: "bash", callId: "a" },
    ]);
    expect(state.tools.map((t) => t.running)).toEqual([false, true]);
  });

  it("ignores a done event for a call it never saw", () => {
    const before = fold([{ kind: "tool", text: "bash: ls", callId: "a" }]);
    expect(applyProgress(before, { kind: "tool_done", text: "bash", callId: "zzz" })).toBe(before);
  });

  it("tracks tok/s and clears it on a new turn", () => {
    const state = fold([{ kind: "tps", tps: 12.5 }]);
    expect(state.tps).toBe(12.5);
    expect(applyProgress(state, { kind: "turn" }).tps).toBeUndefined();
  });
});
