import { describe, expect, it } from "vitest";
import { accumulate, progressOf, type ThreadViewState } from "../web/src/thread-progress.ts";

const view = (docs: Record<string, unknown>): ThreadViewState => ({ docs });

describe("progressOf", () => {
  it("is empty without a view or a running generation", () => {
    expect(progressOf(undefined)).toEqual({ thinking: "", tools: [], queued: [] });
    expect(progressOf(view({ "pi.live": {} }))).toEqual({ thinking: "", tools: [], queued: [] });
  });

  it("joins the thinking blocks of the streamed partial", () => {
    const progress = progressOf(
      view({
        "pi.live": {
          run: { taskId: "t", inputs: [] },
          generation: {
            attempt: 1,
            message: { content: [{ type: "thinking", thinking: "a".repeat(4000) }, { type: "text", text: "hi" }, { type: "thinking", thinking: "b" }] },
          },
        },
      }),
    );
    expect(progress.thinking).toBe("a".repeat(4000) + "b");
  });

  it("lists model and nested tool calls, marking the finished ones", () => {
    const progress = progressOf(
      view({
        "pi.live": {
          run: { taskId: "t", inputs: [] },
          generation: {
            attempt: 1,
            message: { content: [{ type: "toolCall", id: "a", arguments: { command: "ls" } }] },
          },
          tools: [
            { callId: "a", name: "bash", status: "done" },
            { callId: "b", name: "codemode", status: "running", arguments: {} },
          ],
          nestedTools: [{ callId: "b/1", parentCallId: "b", name: "mem_search", status: "running", arguments: { query: "x" } }],
        },
      }),
    );
    expect(progress.tools).toEqual([
      { callId: "a", text: 'bash: {"command":"ls"}', running: false },
      { callId: "b", text: "codemode", running: true },
      { callId: "b/1", text: '↳ mem_search: {"query":"x"}', running: true },
    ]);
  });

  it("derives tok/s from the partial's output tokens over the run time", () => {
    const live = { run: { taskId: "t", inputs: [] }, generation: { attempt: 1, message: { content: [], usage: { output: 50 } } } };
    expect(progressOf(view({ "pi.live": live }), 1000, 5000).tps).toBe(12.5);
    expect(progressOf(view({ "pi.live": live }), undefined, 5000).tps).toBeUndefined();
  });

  it("lists queued steers and follow-ups, with their text, and skips writes", () => {
    const progress = progressOf(
      view({
        "pi.inbox": {
          items: [
            { id: "1", mode: "steer", content: [{ type: "text", text: "use pnpm" }] },
            { id: "2", mode: "followUp", content: "run the tests" },
            { id: "3", mode: "write", entry: { kind: "app.note" } },
          ],
        },
      }),
    );
    expect(progress.queued).toEqual([
      { id: "1", mode: "steer", text: "use pnpm" },
      { id: "2", mode: "followUp", text: "run the tests" },
    ]);
  });
});

describe("accumulate", () => {
  it("keeps finished tools and earlier thinking for the whole turn", () => {
    const tool = (callId: string, running: boolean) => ({ callId, text: "bash: ls", running });
    let log = accumulate(undefined, { thinking: "plan", tools: [], queued: [] });
    log = accumulate(log, { thinking: "plan more", tools: [], queued: [] });
    log = accumulate(log, { thinking: "", tools: [tool("a", true)], queued: [] });
    log = accumulate(log, { thinking: "", tools: [tool("a", false)], queued: [] });
    log = accumulate(log, { thinking: "", tools: [], queued: [] });
    log = accumulate(log, { thinking: "answer", tools: [], queued: [] });
    expect(log.thinking).toBe("plan more\n\nanswer");
    expect(log.tools).toEqual([tool("a", false)]);
  });
});
