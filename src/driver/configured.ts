import type { SettingsStore } from "../settings.js";
import { ClaudeDriver } from "./claude.js";
import { OpenCodeDriver } from "./opencode.js";
import type { AgentDriver, AgentTurnInput, AgentTurnResult } from "./types.js";

export interface ConfiguredDriverOptions {
  opencodeBin: string;
  claudeBin: string;
  timeoutMs: number;
}

/** Picks driver (thread override first) and model from the control-plane settings on every turn. */
export class ConfiguredDriver implements AgentDriver {
  private settings: SettingsStore;
  private options: ConfiguredDriverOptions;

  constructor(settings: SettingsStore, options: ConfiguredDriverOptions) {
    this.settings = settings;
    this.options = options;
  }

  runTurn(input: AgentTurnInput): Promise<AgentTurnResult> {
    const s = this.settings.get();
    const { opencodeBin, claudeBin, timeoutMs } = this.options;
    const kind = input.driver ?? s.agentDriver;
    const driver =
      kind === "claude"
        ? new ClaudeDriver({ bin: claudeBin, model: s.models.claude, timeoutMs })
        : new OpenCodeDriver({ bin: opencodeBin, model: s.models.opencode, agent: s.agents?.opencode, timeoutMs });
    return driver.runTurn(input);
  }
}
