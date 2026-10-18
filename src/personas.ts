import type { RoomEntry, RoomMember } from "./store.js";

/** Display name of the default agent in chats. */
export const BOT_NAME = "Switchi";

/** Named agents (@ventas, @dev…) that live inside a chat thread, each with its own session. */
export interface PersonaAvatar {
  color: string;
  shape: "round" | "soft" | "tall" | "bean";
  expression: "idle" | "wink" | "happy" | "sleepy" | "curious";
}

export interface Persona {
  name: string;
  prompt: string;
  driver?: "pi";
  model?: string;
  listen?: "mentions" | "all";
  respondTo?: "anyone" | "people";
  avatar?: PersonaAvatar;
}

/** What a room-mode agent answers when a message is not for it; never posted. */
export const PASS = "PASS";

export function roomPrompt(text: string): string {
  return `[Room message, not addressed to you. Reply with exactly ${PASS} unless you have something genuinely useful to add.]\n${text}`;
}

const stopped = new Set<string>();
/** Asks the running agent round in a thread to stop after the current turn. */
export function requestStop(threadKey: string): void {
  stopped.add(threadKey);
}
export function takeStop(threadKey: string): boolean {
  return stopped.delete(threadKey);
}

export const PERSONA_NAME = /^[a-z0-9][a-z0-9_-]{0,31}$/i;

/** Agent-to-agent handoffs one human message may trigger, so two agents cannot ping-pong forever. */
export const MAX_HOPS = 3;
/** Extra room when 2+ agents are invited to discuss (floor passes between them). */
export const MAX_DIALOGUE_HOPS = 6;

/** Human is asking agents to talk among themselves (not just talking about them). */
export const DIALOGUE_HINT = /\b(habl[aeá]|talk\s+to|talk\s+with|ask|pregunt|discut|debate|llam[ae]|ping|entre\s+ustedes|coordina)\b/i;

/** Human is asking the host's opinion about named agents — host answers, then consults them. */
export const CONSULT_HINT = /\b(opin|qué\s+opinas|what\s+do\s+you\s+think|think\s+about|think\s+of|pens[aáe]|parecer)\b/i;

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

/**
 * Room agents named without @: "habla con architect" → architect.
 * Only used when there is no @mention; whole-word match so "architecture" ≠ architect.
 */
export function namedPersonas(text: string, personas: Persona[]): Persona[] {
  const found: { at: number; p: Persona }[] = [];
  for (const p of personas) {
    const re = new RegExp(`(^|[^\\w@])${p.name.replace(/[-]/g, "\\-")}(?![\\w-])`, "i");
    const m = re.exec(text);
    if (m) found.push({ at: m.index + (m[1] ? m[1].length : 0), p });
  }
  return found.sort((a, b) => a.at - b.at).map((f) => f.p);
}

/**
 * Who is directly addressed (skips the default agent): @mentions, bare names in a
 * dialogue ask ("habla con architect"), or @one + bare others.
 * "qué opinas de architect" is empty here — the host answers first, then consults them.
 */
export function addressedPersonas(text: string, personas: Persona[]): Persona[] {
  const at = mentionedPersonas(text, personas);
  const named = namedPersonas(text, personas);
  if (at.length) {
    const seen = new Set(at.map((p) => p.name.toLowerCase()));
    return [...at, ...named.filter((p) => !seen.has(p.name.toLowerCase()))];
  }
  if (!named.length) return [];
  return DIALOGUE_HINT.test(text) ? named : [];
}

/** Opening line when several agents are invited to discuss together. */
export function dialogueOpen(said: string, peers: Persona[]): string {
  const names = peers.map((p) => `@${p.name}`).join(", ");
  return (
    `[Discussion with ${names}] You are talking with the other agents, not only answering the human. ` +
    `Give your take, then write @name when you want one of them to respond. ` +
    `Write @${BOT_NAME} to bring the main agent back in. ` +
    `If you have nothing to add after someone speaks, reply exactly ${PASS}.\n\n${said}`
  );
}

/** Pass the floor to the next agent after a peer spoke. */
export function dialoguePass(from: { name: string }, reply: string): string {
  return (
    `[Discussion] @${from.name} just said:\n${reply}\n\n` +
    `Respond to them. Write @${from.name} if you want them to continue. ` +
    `Write @${BOT_NAME} to bring the main agent back in. ` +
    `Reply exactly ${PASS} if you agree and have nothing useful to add.`
  );
}

/** After the host spoke about named agents: invite them to react and keep the discussion going. */
export function consultOpen(said: string, hostReply: string): string {
  return (
    `[Consultation] ${BOT_NAME} said:\n${hostReply}\n\n` +
    `Human: ${said}\n\n` +
    `Give your take. Write @${BOT_NAME} when you want the main agent to continue. ` +
    `Reply exactly ${PASS} if you have nothing useful to add.`
  );
}

/** True when a reply calls the main agent back (@Switchi / Switchboard). */
export function mentionsBot(text: string): boolean {
  const re = new RegExp(`(^|[^\\w@])@?(?:${BOT_NAME.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}|switchboard)(?![\\w-])`, "i");
  return re.test(text);
}

/** Agents the host should pull in after answering ("qué opinas de architect"). */
export function consultTopics(text: string, personas: Persona[]): Persona[] {
  if (!CONSULT_HINT.test(text)) return [];
  return namedPersonas(text, personas);
}

/** Agents tend to echo the "@name:" prefix they see on other agents' messages; drop it from their own reply. */
export function stripSelfPrefix(reply: string, p: Persona): string {
  return reply.replace(new RegExp(`^\\s*\\**@${p.name}\\**\\s*(?:(?:→|->)\\s*@?[\\w-]+\\**\\s*)?(?::\\s*|\\s+(?=\\S))`, "i"), "");
}

const ROOM_KEEP = 30;
const ROOM_CHARS = 1500;

/** Appends one message to the thread's room log (capped). */
export function roomAppend(log: RoomEntry[] | undefined, author: string, text: string): RoomEntry[] {
  const list = log ?? [];
  const n = (list.at(-1)?.n ?? 0) + 1;
  const t = text.length > ROOM_CHARS ? `${text.slice(0, ROOM_CHARS)}…` : text;
  return [...list, { n, author, text: t }].slice(-ROOM_KEEP);
}

/** "What you missed" block: messages by others after `seen` and before `before`; empty when nothing new. */
export function roomCatchUp(log: RoomEntry[] | undefined, who: string, seen: number | undefined, before: number): string {
  const missed = (log ?? []).filter((e) => e.n > (seen ?? 0) && e.n < before && e.author !== who);
  if (!missed.length) return "";
  const lines = missed.map((e) => `${e.author}: ${e.text}`).join("\n");
  return `Messages in this chat since your last turn (for context):\n${lines}\n\n---\n\n`;
}

/** Opening of a persona's session: who it is and who else is in the room. */
export function personaPreamble(p: Persona, all: Persona[]): string {
  const room = p.listen === "all" ? `You see every message in the chat. When one is not for you and you have nothing useful to add, reply exactly ${PASS}.` : "";
  const others = all.filter((o) => o.name !== p.name).map((o) => `@${o.name}`);
  return [
    `You are @${p.name}, one of several agents in a shared team chat.`,
    p.prompt.trim(),
    others.length
      ? `Other agents here: ${others.join(", ")}. Writing @name in your reply makes that agent answer right away, so only write @name when you are asking them something now; to just refer to them, write their name without the @.`
      : "",
    "People address you with @" + p.name + ". Messages from other agents start with their @name.",
    room,
  ]
    .filter(Boolean)
    .join("\n\n");
}

/**
 * Agents an agent's reply actually asks something: the sentence with @name starts with it
 * or ends in "?". "Perfecto, @designer." or "coordino con @designer" is a mention, not a question.
 */
export function askedPersonas(reply: string, personas: Persona[]): Persona[] {
  const sentences = reply.split(/(?<=[.!?\n])/).map((s) => s.trim());
  return mentionedPersonas(reply, personas).filter((p) =>
    sentences.some((s) => mentionedPersonas(s, [p]).length > 0 && (/^[*_]*@/.test(s) && s.toLowerCase().replace(/^[*_]*/, "").startsWith(`@${p.name.toLowerCase()}`) || /\?[*_)\s]*$/.test(s))),
  );
}

/** Catalog agents usable in a room: its agent members, or the whole catalog for rooms without a member list. */
export function activePersonas(all: Persona[], members: RoomMember[] | undefined): Persona[] {
  if (!members) return all;
  const inRoom = new Set(members.filter((m) => m.kind === "agent").map((m) => (m as { persona: string }).persona.toLowerCase()));
  return all.filter((p) => inRoom.has(p.name.toLowerCase()));
}

/** Adds a human by display name (case-insensitive) if not already a member. */
export function withHuman(members: RoomMember[], name: string, now = new Date().toISOString()): RoomMember[] {
  const id = `human:${name.trim().toLowerCase()}`;
  return members.some((m) => m.id === id) ? members : [...members, { kind: "human", id, name: name.trim(), joinedAt: now }];
}

export function withAgent(members: RoomMember[], persona: string, now = new Date().toISOString()): RoomMember[] {
  const id = `agent:${persona.toLowerCase()}`;
  return members.some((m) => m.id === id) ? members : [...members, { kind: "agent", id, persona, joinedAt: now }];
}

export const MAX_INTERJECTIONS = 1;

export const ADD_HINT = /\b(agreg|añad|sum[aá]|invit|tra[eé]|met[eé]|volv[eé]|add|invite|bring)\w*/i;

export function hostPreamble(personas: Persona[], hostPrompt?: string): string {
  const roster = personas.map((p) => `@${p.name}${p.prompt.trim() ? ` (${p.prompt.trim().slice(0, 120)})` : ""}`).join("; ");
  const base = [
    `You are ${BOT_NAME}, the host of this shared chat. People talk to you; other agents are members of the room too.`,
    roster ? `Agents in this room: ${roster}.` : "No other agents are in this room yet.",
    "When a message is about one of them (even named without @), or their opinion would help, ask them: start a sentence with @name or end it with a question mark. Otherwise just answer yourself.",
    `If a person asks to add an agent back to the room, use the invite_agent tool. Removed agents cannot be called until someone adds them again.`,
  ].join("\n");
  const extra = hostPrompt?.trim();
  return extra ? `${base}\n\n${extra}` : base;
}

export function rosterUpdate(before: string[] | undefined, now: string[]): string {
  if (!before) return "";
  const was = new Set(before.map((n) => n.toLowerCase()));
  const is = new Set(now.map((n) => n.toLowerCase()));
  const joined = now.filter((n) => !was.has(n.toLowerCase())).map((n) => `@${n} joined`);
  const left = before.filter((n) => !is.has(n.toLowerCase())).map((n) => `@${n} left (do not call them)`);
  const changes = [...joined, ...left];
  return changes.length ? `\n\n[Room update: ${changes.join(", ")}]` : "";
}

const answeringNow = new Map<string, Set<string>>();
export function setAnswering(threadKey: string, name: string, on: boolean): void {
  const set = answeringNow.get(threadKey) ?? new Set<string>();
  if (on) set.add(name);
  else set.delete(name);
  if (set.size) answeringNow.set(threadKey, set);
  else answeringNow.delete(threadKey);
}
export function answering(threadKey: string): string[] {
  return [...(answeringNow.get(threadKey) ?? [])];
}

export function humanAskedFor(room: RoomEntry[] | undefined, name: string): boolean {
  const last = [...(room ?? [])].reverse().find((e) => !e.author.startsWith("@") && e.author !== BOT_NAME);
  if (!last) return false;
  return new RegExp(`(^|[^\w])@?${name.replace(/[-]/g, "\-")}(?![\w-])`, "i").test(last.text);
}
