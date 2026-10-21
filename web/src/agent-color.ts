import type { CSSProperties } from "react";

export const BOT_NAME = "Switchi";

/** Stable hue per agent name, so @ventas always has the same color everywhere. */
export function agentHue(name: string): number {
  let h = 0;
  for (const ch of name.replace(/^@/, "").toLowerCase()) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h % 360;
}

/** Inline style for `.agent-tint`: sets the hue the CSS turns into avatar and name colors. */
export function agentTint(name: string): CSSProperties {
  return { "--agent-hue": agentHue(name) } as CSSProperties;
}
