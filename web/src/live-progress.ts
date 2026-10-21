/** Live progress relayed from the pi harness over SSE (see harness/progress.ts for the producer). */
export type ProgressEvent =
  | { kind: "turn" }
  | { kind: "thinking"; text: string }
  | { kind: "tool"; text: string; callId?: string }
  | { kind: "tool_done"; text: string; callId?: string }
  | { kind: "tps"; tps: number }
  | { kind: "idle" };

export type ToolLine = { callId?: string; text: string; running: boolean };
export type Progress = { thinking: string; tools: ToolLine[]; tps?: number };

export const emptyProgress: Progress = { thinking: "", tools: [] };

/** Thinking is appended whole: the producer never truncates it. */
export function applyProgress(state: Progress, event: ProgressEvent): Progress {
  switch (event.kind) {
    case "turn":
      return emptyProgress;
    case "thinking":
      return { ...state, thinking: state.thinking + event.text };
    case "tps":
      return { ...state, tps: event.tps };
    case "tool":
      return { ...state, tools: [...state.tools, { callId: event.callId, text: event.text, running: true }] };
    case "tool_done": {
      let hit = -1;
      for (let i = state.tools.length - 1; i >= 0; i -= 1) {
        const tool = state.tools[i];
        if (tool?.running && (!event.callId || tool.callId === event.callId)) {
          hit = i;
          break;
        }
      }
      if (hit < 0) return state;
      return { ...state, tools: state.tools.map((tool, i) => (i === hit ? { ...tool, running: false } : tool)) };
    }
    case "idle":
      return state;
  }
}
