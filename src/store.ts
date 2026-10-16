import { readFileSync } from "node:fs";
import { rename, unlink, writeFile } from "node:fs/promises";

export interface SessionRecord {
  sessionRef?: string;
  space: string;
  updatedAt: string;
  /** Repo name from the repos config, set by /repo. */
  repo?: string;
  /** Git worktree the agent works in for this thread. */
  worktree?: string;
  branch?: string;
  /** Per-thread model override set with /model. */
  model?: string;
  /** Summary from /compact, prepended to the next turn of the fresh session. */
  summary?: string;
  /** Context size after the last turn; `estimated` when the agent does not report it. */
  contextTokens?: number;
  contextWindow?: number;
  estimated?: boolean;
  turns?: number;
}

/** threadKey -> session record, persisted as JSON with atomic writes (tmp + rename). */
export class SessionStore {
  private entries: Map<string, SessionRecord> = new Map();
  private filePath: string;
  private tmpSeq = 0;

  constructor(filePath: string) {
    this.filePath = filePath;
    this.load();
  }

  private load(): void {
    let raw: string;
    try {
      raw = readFileSync(this.filePath, "utf8");
    } catch {
      return; // missing file -> empty store
    }
    try {
      const parsed: unknown = JSON.parse(raw);
      if (parsed && typeof parsed === "object") {
        for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
          this.entries.set(key, value as SessionRecord);
        }
      }
    } catch (err) {
      console.error(`[store] ignoring corrupt ${this.filePath}:`, err);
    }
  }

  all(): [string, SessionRecord][] {
    return [...this.entries];
  }

  get(threadKey: string): SessionRecord | undefined {
    return this.entries.get(threadKey);
  }

  /** Merges fields into the thread's record (creating it) and persists. */
  async update(threadKey: string, space: string, patch: Partial<SessionRecord>): Promise<void> {
    await this.set(threadKey, {
      ...this.entries.get(threadKey),
      ...patch,
      space,
      updatedAt: new Date().toISOString(),
    });
  }

  async set(threadKey: string, record: SessionRecord): Promise<void> {
    this.entries.set(threadKey, record);
    // Unique staging name: concurrent set() calls from different threads must
    // not overwrite each other's tmp file before rename.
    const tmp = `${this.filePath}.${Date.now()}.${++this.tmpSeq}.tmp`;
    try {
      await writeFile(tmp, `${JSON.stringify(Object.fromEntries(this.entries), null, 2)}\n`, "utf8");
      await rename(tmp, this.filePath);
    } catch (err) {
      await unlink(tmp).catch(() => {});
      throw err;
    }
  }
}
