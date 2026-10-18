export interface AgentQuestion {
  header: string;
  question: string;
  options: { label: string; description?: string }[];
  multiple?: boolean;
}

export interface PendingAgent {
  questions: AgentQuestion[];
  resume(answer: string): Promise<AgentTurnResult>;
  cancel(): void;
}

export interface AgentTurnInput {
  threadKey: string;
  sessionRef?: string;
  text: string;
  workdir: string;
  model?: string;
  agent?: string;
  driver?: "pi";
  answerQuestions?: boolean;
}

export interface ContextUsage {
  contextTokens: number;
  contextWindow?: number;
}

export interface AgentTurnResult {
  reply: string;
  sessionRef?: string;
  usage?: ContextUsage;
  pending?: PendingAgent;
}

export interface AgentDriver {
  runTurn(input: AgentTurnInput): Promise<AgentTurnResult>;
}
