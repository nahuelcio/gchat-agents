import { clampThinkingLevel, type Model } from "@earendil-works/pi-ai/models";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";

export function effortFor(model: Model | undefined, requested?: string): ModelThinkingLevel {
  const level: ModelThinkingLevel = LEVELS.includes(requested as EffortLevel) ? (requested as ModelThinkingLevel) : "high";
  if (level === "off") return "off";
  if (model?.reasoning && model.thinkingLevelMap) return clampThinkingLevel(model, level);
  return level;
}

const LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
type EffortLevel = (typeof LEVELS)[number];
