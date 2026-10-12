import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

const base = {
  GOOGLE_TOKEN_AUDIENCE: "https://chat.example.com/google/chat",
  GOOGLE_SERVICE_ACCOUNT_JSON: "/tmp/sa.json",
  CHAT_ALLOWED_SPACES: "spaces/AAA",
};

describe("loadConfig driver selection", () => {
  it("defaults to the opencode driver", () => {
    expect(loadConfig(base).agentDriver).toBe("opencode");
  });

  it("selects the claude driver and carries its bin/model", () => {
    const config = loadConfig({ ...base, AGENT_DRIVER: "claude", CLAUDE_MODEL: "claude-sonnet-4-5" });
    expect(config.agentDriver).toBe("claude");
    expect(config.claudeBin).toBe("claude");
    expect(config.claudeModel).toBe("claude-sonnet-4-5");
  });

  it("rejects unknown driver kinds instead of silently falling back", () => {
    expect(() => loadConfig({ ...base, AGENT_DRIVER: "gemini" })).toThrow(/AGENT_DRIVER/);
  });
});
