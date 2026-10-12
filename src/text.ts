const MENTION = /<@[^>]*>/g;

/** Text to send to the agent: argumentText (mention already removed), else text with mentions stripped. */
export function extractPrompt(message: { argumentText?: string; text?: string }): string {
  const arg = message.argumentText?.trim();
  if (arg) return arg;
  return (message.text ?? "").replace(MENTION, " ").trim();
}

/**
 * Split text into chunks of at most `limit` chars, preferring newline boundaries.
 * Concatenating the chunks reproduces the original text.
 */
export function chunkText(text: string, limit: number): string[] {
  if (text.length <= limit) return [text];
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > limit) {
    let cut = rest.lastIndexOf("\n", limit);
    if (cut <= 0) cut = limit; // no newline in range: hard cut
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if (rest.length > 0) chunks.push(rest);
  return chunks;
}
