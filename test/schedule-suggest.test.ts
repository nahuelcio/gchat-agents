import { describe, expect, it } from "vitest";
import type { AgentDriver } from "../src/driver/types.js";
import { parseSuggestion, suggestPrompt, suggestSchedule } from "../src/schedule-suggest.js";

describe("schedule suggest", () => {
  it("builds a prompt that demands JSON only", () => {
    expect(suggestPrompt("weekdays at 9 summarize commits")).toMatch(/ONLY valid JSON/);
    expect(suggestPrompt("weekdays at 9 summarize commits")).toContain("weekdays at 9 summarize commits");
  });

  it("parses a clean JSON reply and describes the cron", () => {
    expect(
      parseSuggestion(`{"name":"Standup digest","prompt":"Summarize yesterday's commits","cron":"0 9 * * 1-5"}`),
    ).toEqual({
      name: "Standup digest",
      prompt: "Summarize yesterday's commits",
      cron: "0 9 * * 1-5",
      when: "Weekdays at 09:00",
    });
  });

  it("tolerates markdown fences and falls back name from prompt", () => {
    const long = "A".repeat(60);
    expect(parseSuggestion("```json\n" + JSON.stringify({ prompt: long, cron: "0 * * * *" }) + "\n```")).toMatchObject({
      name: `${"A".repeat(47)}…`,
      cron: "0 * * * *",
      when: "Every hour",
    });
  });

  it("rejects missing fields and bad cron", () => {
    expect(() => parseSuggestion("no json here")).toThrow(/JSON object/);
    expect(() => parseSuggestion('{"cron":"0 9 * * 1-5"}')).toThrow(/prompt/);
    expect(() => parseSuggestion('{"prompt":"x","cron":"bad"}')).toThrow(/cron/);
  });

  it("runs the driver and returns a validated suggestion", async () => {
    const driver: AgentDriver = {
      runTurn: async () => ({
        reply: 'Sure.\n{"name":"Nightly","prompt":"Run the smoke suite","cron":"0 2 * * *"}\n',
      }),
    };
    await expect(suggestSchedule(driver, "every night at 2 run smoke", "/tmp")).resolves.toEqual({
      name: "Nightly",
      prompt: "Run the smoke suite",
      cron: "0 2 * * *",
      when: "Every day at 02:00",
    });
  });

  it("requires non-empty text", async () => {
    const driver: AgentDriver = { runTurn: async () => ({ reply: "{}" }) };
    await expect(suggestSchedule(driver, "  ", "/tmp")).rejects.toThrow(/plain language/);
  });
});
