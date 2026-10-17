import { describe, expect, it } from "vitest";
import { cleanForSpeech } from "../web/src/speech";

describe("cleanForSpeech", () => {
  it("strips markdown images, links and emphasis for TTS", () => {
    expect(cleanForSpeech("See ![x](https://a/b.png) and [docs](https://d.io) **now**")).toBe("See and docs now");
  });
});
