import { describe, expect, it } from "vite-plus/test";
import { cleanForSpeech } from "../web/src/speech";

describe("cleanForSpeech", () => {
  it("strips markdown images, links and emphasis for TTS", () => {
    expect(cleanForSpeech("See ![x](https://a/b.png) and [docs](https://d.io) **now**")).toBe(
      "See and docs now",
    );
  });

  it("drops fenced code blocks so TTS does not read artifacts raw", () => {
    expect(cleanForSpeech("Hola\n```html\n<div>quiz</div>\n```\nmundo")).toBe("Hola mundo");
  });
});
