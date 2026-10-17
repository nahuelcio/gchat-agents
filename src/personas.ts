/** Named agents (@ventas, @dev…) that live inside a chat thread, each with its own session. */
export interface Persona {
  /** Mention handle, without the @. */
  name: string;
  /** Who this agent is and what it knows; sent as the opening of its session. */
  prompt: string;
  driver?: "opencode" | "claude";
  model?: string;
  /** Existing OpenCode agent to run as (opencode --agent), e.g. orchestrator. */
  agent?: string;
}

export const PERSONA_NAME = /^[a-z0-9][a-z0-9_-]{0,31}$/i;

/** Agent-to-agent handoffs one human message may trigger, so two agents cannot ping-pong forever. */
export const MAX_HOPS = 3;

/** Personas mentioned as @name, in order of first appearance (case-insensitive, no duplicates). */
export function mentionedPersonas(text: string, personas: Persona[]): Persona[] {
  const found: { at: number; p: Persona }[] = [];
  for (const p of personas) {
    const re = new RegExp(`(^|[^\\w@])@${p.name.replace(/[-]/g, "\\-")}(?![\\w-])`, "i");
    const m = re.exec(text);
    if (m) found.push({ at: m.index, p });
  }
  return found.sort((a, b) => a.at - b.at).map((f) => f.p);
}

/** Agents tend to echo the "@name:" prefix they see on other agents' messages; drop it from their own reply. */
export function stripSelfPrefix(reply: string, p: Persona): string {
  return reply.replace(new RegExp(`^\\s*\\**@${p.name}\\**\\s*:\\s*`, "i"), "");
}

/** Opening of a persona's session: who it is and who else is in the room. */
export function personaPreamble(p: Persona, all: Persona[]): string {
  const others = all.filter((o) => o.name !== p.name).map((o) => `@${o.name}`);
  return [
    `You are @${p.name}, one of several agents in a shared team chat.`,
    p.prompt.trim(),
    others.length
      ? `Other agents here: ${others.join(", ")}. To ask one of them something, write their @name followed by the question in your reply; they will answer in the thread. Only do it when you really need them.`
      : "",
    "People address you with @" + p.name + ". Messages from other agents start with their @name.",
  ]
    .filter(Boolean)
    .join("\n\n");
}
