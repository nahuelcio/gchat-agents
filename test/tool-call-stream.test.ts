import { describe, expect, it } from "vitest";
import { toolCallStreamFixer } from "../harness/tool-call-stream";

const chunk = (delta: object, finish_reason: string | null = null) => ({ id: "chatcmpl_stream", choices: [{ index: 0, delta, finish_reason }] });

describe("toolCallStreamFixer", () => {
  it("repairs mislabeled parallel tool call deltas and the finish reason", () => {
    // Captured from a TokenBank backend: the second call's arguments arrive tagged index 0.
    const chunks = [
      chunk({ tool_calls: [{ index: 0, id: "a", type: "function", function: { name: "bash", arguments: "" } }] }),
      chunk({ tool_calls: [{ index: 0, function: { arguments: '{"command":"pwd"}' } }] }),
      chunk({ tool_calls: [{ index: 1, id: "b", type: "function", function: { name: "bash", arguments: "" } }] }),
      chunk({ tool_calls: [{ index: 0, function: { arguments: '{"command":"ls /tmp"}' } }] }),
      chunk({}, "stop"),
    ];
    const fix = toolCallStreamFixer();
    chunks.forEach(fix);
    expect(chunks[3].choices[0].delta).toEqual({ tool_calls: [{ index: 1, function: { arguments: '{"command":"ls /tmp"}' } }] });
    expect(chunks[4].choices[0].finish_reason).toBe("tool_calls");
  });

  it("leaves well-formed streams alone", () => {
    const chunks = [
      chunk({ tool_calls: [{ index: 0, id: "a", function: { name: "bash", arguments: '{"comm' } }] }),
      chunk({ tool_calls: [{ index: 0, function: { arguments: 'and":"pwd"}' } }] }),
      chunk({}, "tool_calls"),
    ];
    const before = structuredClone(chunks);
    const fix = toolCallStreamFixer();
    chunks.forEach(fix);
    expect(chunks).toEqual(before);

    const text = [chunk({ content: "hi" }), chunk({}, "stop")];
    text.forEach(toolCallStreamFixer());
    expect(text[1].choices[0].finish_reason).toBe("stop");
  });
});
