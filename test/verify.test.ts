import { describe, expect, it } from "vitest";
import { audienceMode } from "../src/verify.js";

describe("audienceMode", () => {
  it("picks the mode from the audience shape", () => {
    expect(audienceMode("https://gchat.example.com/google/chat")).toBe("url");
    expect(audienceMode("1234567890")).toBe("project");
  });
});
