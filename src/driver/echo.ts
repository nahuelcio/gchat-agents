import type { AgentDriver, AgentTurnInput, AgentTurnResult } from "./types.js";

/** Canned driver for tests and smoke runs without an agent. */
export class EchoDriver implements AgentDriver {
  async runTurn(input: AgentTurnInput): Promise<AgentTurnResult> {
    return { reply: `Echo: ${input.text}`, sessionRef: `echo-${input.threadKey}` };
  }
}
