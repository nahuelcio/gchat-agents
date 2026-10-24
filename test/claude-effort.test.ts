import type { Model } from "@earendil-works/pi-ai/models";
import { expect, test } from "vitest";
import { effortFor } from "../harness/effort.ts";

const model = (thinkingLevelMap: Model["thinkingLevelMap"], reasoning = true): Model => ({ reasoning, thinkingLevelMap }) as Model;

test("any reasoning model asks for high effort", () => {
  const opus = model({ off: null, minimal: null, low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" });
  expect(effortFor(opus)).toBe("high");
  expect(effortFor(opus, "max")).toBe("max");
  expect(effortFor(opus, "off")).toBe("off");
  expect(effortFor(model(undefined, false), "max")).toBe("max");
  expect(effortFor(undefined)).toBe("high");
  expect(effortFor(undefined, "off")).toBe("off");
});

test("effort moves to the next level the model actually lists", () => {
  const fable = model({ off: null, minimal: null, low: null, medium: null, high: null, xhigh: "xhigh", max: "max" });
  expect(effortFor(fable)).toBe("xhigh");
});
