export interface AgentTurnInput {
  threadKey: string;
  /** Opencode session id from a previous turn, to continue the same conversation. */
  sessionRef?: string;
  text: string;
  workdir: string;
}

export interface AgentTurnResult {
  reply: string;
  /** Session id to pass back on the next turn of this thread. */
  sessionRef?: string;
}

export interface AgentDriver {
  runTurn(input: AgentTurnInput): Promise<AgentTurnResult>;
}
