import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

const base = {
  GOOGLE_TOKEN_AUDIENCE: "https://chat.example.com/google/chat",
  GOOGLE_SERVICE_ACCOUNT_JSON: "/tmp/sa.json",
  CHAT_ALLOWED_SPACES: "spaces/AAA",
};

describe("loadConfig driver selection", () => {
  it("defaults to pi", () => {
    expect(loadConfig(base).agentDriver).toBe("pi");
  });

  it("coerces legacy opencode/claude seeds to pi", () => {
    expect(loadConfig({ ...base, AGENT_DRIVER: "opencode" }).agentDriver).toBe("pi");
    expect(loadConfig({ ...base, AGENT_DRIVER: "claude" }).agentDriver).toBe("pi");
  });

  it("rejects unknown driver kinds instead of silently falling back", () => {
    expect(() => loadConfig({ ...base, AGENT_DRIVER: "gemini" })).toThrow(/AGENT_DRIVER/);
  });
});
