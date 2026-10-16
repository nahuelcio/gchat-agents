import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

/** Commands a team chat guest may run: chat and session only, nothing that touches this machine. */
export const GUEST_COMMANDS: ReadonlySet<string> = new Set(["help", "context", "compact", "clear", "model", "agent"]);

/**
 * Access token for the team chat link (public port). Created on first start,
 * kept in DATA_DIR/share-token (0600); rotating it cuts off every old link.
 */
export class ShareToken {
  private file: string;
  private token: string;

  constructor(file: string) {
    this.file = file;
    let saved = "";
    try {
      saved = readFileSync(file, "utf8").trim();
    } catch {
      // first start
    }
    this.token = /^[a-f0-9]{48}$/.test(saved) ? saved : this.write();
  }

  private write(): string {
    const token = randomBytes(24).toString("hex");
    writeFileSync(this.file, `${token}\n`, { mode: 0o600 });
    return token;
  }

  value(): string {
    return this.token;
  }

  rotate(): string {
    this.token = this.write();
    return this.token;
  }

  check(candidate: string | undefined): boolean {
    if (!candidate) return false;
    const a = Buffer.from(candidate);
    const b = Buffer.from(this.token);
    return a.length === b.length && timingSafeEqual(a, b);
  }
}
