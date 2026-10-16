import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface TranscriptMessage {
  author: string;
  text: string;
  bot: boolean;
  at?: string;
}

/**
 * Message history of web threads (team chat), so a deeplink shows the whole
 * conversation and teammates see each other's messages. One JSON file per thread.
 */
export class TranscriptStore {
  private dir: string;
  private max: number;
  private cache = new Map<string, TranscriptMessage[]>();
  private writing = new Map<string, Promise<void>>();

  constructor(dir: string, max = 500) {
    this.dir = dir;
    this.max = max;
    mkdirSync(dir, { recursive: true });
  }

  /** Thread keys become flat, safe file names. */
  fileFor(threadKey: string): string {
    return join(this.dir, `${threadKey.replace(/[^\w-]+/g, "_")}.json`);
  }

  /** Threads whose key starts with `prefix` (e.g. "share/"), newest activity first. */
  list(prefix: string): { key: string; title: string; updatedAt?: string; count: number }[] {
    const filePrefix = prefix.replace(/[^\w-]+/g, "_");
    let files: string[] = [];
    try {
      files = readdirSync(this.dir).filter((f) => f.startsWith(filePrefix) && f.endsWith(".json"));
    } catch {
      // no transcripts yet
    }
    return files
      .map((f) => {
        const key = prefix + f.slice(filePrefix.length, -".json".length);
        const messages = this.get(key);
        const first = messages.find((m) => !m.bot)?.text ?? "New thread";
        return { key, title: first.slice(0, 60), updatedAt: messages.at(-1)?.at, count: messages.length };
      })
      .sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
  }

  get(threadKey: string): TranscriptMessage[] {
    let messages = this.cache.get(threadKey);
    if (!messages) {
      try {
        messages = JSON.parse(readFileSync(this.fileFor(threadKey), "utf8")) as TranscriptMessage[];
      } catch {
        messages = [];
      }
      this.cache.set(threadKey, messages);
    }
    return messages;
  }

  async append(threadKey: string, messages: TranscriptMessage[]): Promise<void> {
    const at = new Date().toISOString();
    const next = [...this.get(threadKey), ...messages.map((m) => ({ at, ...m }))].slice(-this.max);
    this.cache.set(threadKey, next);
    // Serialized per thread; each write persists the latest state (see SessionStore.set).
    const write = (this.writing.get(threadKey) ?? Promise.resolve()).then(async () => {
      const file = this.fileFor(threadKey);
      const tmp = `${file}.${Date.now()}.tmp`;
      await writeFile(tmp, JSON.stringify(this.get(threadKey)), "utf8");
      await rename(tmp, file);
    });
    this.writing.set(threadKey, write.catch(() => {}));
    return write;
  }
}
