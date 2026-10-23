/** Conversations to abort for a thread key: the thread itself plus its persona runs (`<thread>#<Persona>`). */
export function abortTargets(threads: Record<string, string>, thread: string): string[] {
  return Object.entries(threads)
    .filter(([, key]) => key === thread || key.startsWith(`${thread}#`))
    .map(([id]) => id);
}
