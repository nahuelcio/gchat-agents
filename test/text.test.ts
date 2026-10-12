import { describe, expect, it } from "vitest";
import { chunkText, extractPrompt } from "../src/text.js";

describe("extractPrompt", () => {
  it("prefers argumentText (mention already removed)", () => {
    expect(
      extractPrompt({
        argumentText: "deploy the service",
        text: "@AgentBot deploy the service",
      }),
    ).toBe("deploy the service");
  });

  it("falls back to text and strips mention markup", () => {
    expect(extractPrompt({ text: "<@user/12345> what is up?" })).toBe("what is up?");
  });

  it("returns empty string for a mention-only message", () => {
    expect(extractPrompt({ text: "<@user/12345>" })).toBe("");
    expect(extractPrompt({})).toBe("");
  });
});

describe("chunkText", () => {
  it("returns short text unchanged", () => {
    expect(chunkText("hello", 3800)).toEqual(["hello"]);
    expect(chunkText("", 3800)).toEqual([""]);
  });

  it("splits on newlines within the limit", () => {
    const text = `${"a".repeat(30)}\n${"b".repeat(30)}\n${"c".repeat(30)}`;
    const chunks = chunkText(text, 40);
    expect(chunks.length).toBe(3);
    expect(chunks.join("")).toBe(text);
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(40);
  });

  it("hard-splits a single line longer than the limit", () => {
    const text = "x".repeat(100);
    const chunks = chunkText(text, 30);
    expect(chunks.join("")).toBe(text);
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(30);
  });

  it("handles exactly-at-limit and boundary newlines", () => {
    expect(chunkText("y".repeat(10), 10)).toEqual(["y".repeat(10)]);
    const text = "\n\nlong";
    expect(chunkText(text, 3).join("")).toBe(text);
  });
});
