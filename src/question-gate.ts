import type { PendingAgent } from "./driver/types.js";

/** Live agent processes blocked on a question, keyed by thread. Not persisted: a restart continues from the stored questions as a new turn. */
const parked = new Map<string, PendingAgent>();

export function holdQuestion(threadKey: string, pending: PendingAgent): void {
  parked.get(threadKey)?.cancel();
  parked.set(threadKey, pending);
}

export function takeQuestion(threadKey: string): PendingAgent | undefined {
  const pending = parked.get(threadKey);
  if (pending) parked.delete(threadKey);
  return pending;
}

export function hasQuestion(threadKey: string): boolean {
  return parked.has(threadKey);
}

export function cancelQuestion(threadKey: string): void {
  parked.get(threadKey)?.cancel();
  parked.delete(threadKey);
}

/** Tests only: drop every parked process so cases don't leak across each other. */
export function clearQuestions(): void {
  for (const pending of parked.values()) pending.cancel();
  parked.clear();
}
