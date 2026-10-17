/** One clarifying question from OpenCode (`multiple`) or Claude (`multiSelect`, normalized). */
export interface AgentQuestion {
  header: string;
  question: string;
  options: { label: string; description?: string }[];
  multiple?: boolean;
}

/** A CLI process paused on AskUserQuestion / the question tool. `resume` feeds the chat reply back in. */
export interface PendingAgent {
  questions: AgentQuestion[];
  resume(answer: string): Promise<AgentTurnResult>;
  cancel(): void;
}

export interface AgentTurnInput {
  threadKey: string;
  /** Opencode session id from a previous turn, to continue the same conversation. */
  sessionRef?: string;
  text: string;
  workdir: string;
  /** Per-thread model override (from /model); omitted = the driver's default. */
  model?: string;
  /** Per-thread agent override (from /agent); omitted = the configured one. */
  driver?: "opencode" | "claude";
  /** When false (scheduled jobs), clarifying questions are declined instead of parked. */
  answerQuestions?: boolean;
}

export interface ContextUsage {
  /** Tokens the session occupies in the model's context after this turn. */
  contextTokens: number;
  contextWindow?: number;
}

export interface AgentTurnResult {
  reply: string;
  /** Session id to pass back on the next turn of this thread. */
  sessionRef?: string;
  /** Reported by agents that expose it (claude); omitted when unknown. */
  usage?: ContextUsage;
  /** Set when the CLI is waiting on the user. The reply is the question text. */
  pending?: PendingAgent;
}

export interface AgentDriver {
  runTurn(input: AgentTurnInput): Promise<AgentTurnResult>;
}
