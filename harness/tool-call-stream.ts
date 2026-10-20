type ToolCallDelta = { index?: number; id?: string; function?: { arguments?: string } };
type Chunk = { choices?: { delta?: { tool_calls?: ToolCallDelta[] }; finish_reason?: string | null }[] };

const isCompleteJson = (s: string) => {
  try {
    JSON.parse(s);
    return true;
  } catch {
    return false;
  }
};

/**
 * Per-response, in-place repair of OpenAI-compatible stream chunks from proxies that
 * (a) tag a later parallel tool call's argument deltas with an earlier call's index and
 * (b) finish with "stop" despite emitting tool calls. pi-ai trusts both; AI SDK tolerates them.
 */
export function toolCallStreamFixer() {
  const args = new Map<number, string>();
  let last: number | undefined;
  return (data: unknown) => {
    const choice = (data as Chunk)?.choices?.[0];
    if (!choice) return;
    for (const tc of choice.delta?.tool_calls ?? []) {
      if (tc.index === undefined) continue;
      if (tc.id) last = tc.index;
      // ponytail: a delta aimed at an already-complete call belongs to the newest call.
      else if (last !== undefined && tc.index !== last && isCompleteJson(args.get(tc.index) ?? "")) tc.index = last;
      args.set(tc.index, (args.get(tc.index) ?? "") + (tc.function?.arguments ?? ""));
    }
    if (choice.finish_reason === "stop" && args.size > 0) choice.finish_reason = "tool_calls";
  };
}
