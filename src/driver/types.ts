export interface AgentTurnInput {
  threadKey: string;
  /** Opencode session id from a previous turn, to continue the same conversation. */
  sessionRef?: string;
  text: string;
  workdir: string;
  /** Per-thread model override (from /model); omitted = the driver's default. */
  model?: string;
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
}

export interface AgentDriver {
  runTurn(input: AgentTurnInput): Promise<AgentTurnResult>;
}
