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
  /** Per-thread agent set with /agent. */
  driver?: "opencode" | "claude";
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
    // Writes run one at a time and each snapshots the map when it starts: concurrent
    // set() calls could otherwise finish out of order and an older snapshot would
    // overwrite a newer one, silently dropping another thread's session.
    const write = this.writing.then(() => this.persist());
    this.writing = write.catch(() => {});
    return write;
  }

  async delete(threadKey: string): Promise<void> {
    this.entries.delete(threadKey);
    const write = this.writing.then(() => this.persist());
    this.writing = write.catch(() => {});
    return write;
  }

  private writing: Promise<void> = Promise.resolve();

  private async persist(): Promise<void> {
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
