import type { AgentDriver, AgentTurnInput, AgentTurnResult } from "./types.js";
import { runCaptured, type CapturedRun } from "./spawn-capture.js";

export interface ClaudeDriverOptions {
  bin: string;
  /** Optional model override. Omitted = claude default. */
  model?: string;
  timeoutMs: number;
}

export interface ParsedClaudeOutput {
  reply: string;
  sessionId?: string;
  error?: string;
}

/** claude session ids are UUIDs; any other stored ref means "start fresh". */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Parse `claude -p --output-format json` output (shape captured from
 * v2.1.296): a single JSON object
 *   {"type":"result","result":"…","session_id":"<uuid>","is_error":false,…}
 * On failure is_error is true and result carries the message — note subtype
 * can still say "success", so is_error is the only reliable signal.
 */
export function parseClaudeOutput(stdout: string): ParsedClaudeOutput {
  let obj: {
    type?: string;
    result?: string;
    session_id?: string;
    is_error?: boolean;
  };
  try {
    obj = JSON.parse(stdout) as typeof obj;
  } catch {
    return { reply: "", error: `unparseable claude output: ${stdout.slice(0, 200)}` };
  }
  if (obj.type !== "result") {
    return { reply: "", error: `unexpected claude output type: ${obj.type ?? "none"}` };
  }
  return {
    reply: obj.is_error ? "" : (obj.result ?? ""),
    sessionId: obj.session_id,
    error: obj.is_error ? (obj.result ?? "claude reported an error") : undefined,
  };
}

/**
 * Runs one agent turn by spawning the real claude CLI:
 *   claude -p --output-format json [--resume <uuid>] [--model <m>] -- <text>
 * Permission prompts are auto-denied in headless mode — same safe posture as
 * the opencode driver.
 */
export class ClaudeDriver implements AgentDriver {
  private bin: string;
  private model?: string;
  private timeoutMs: number;

  constructor(options: ClaudeDriverOptions) {
    this.bin = options.bin;
    this.model = options.model;
    this.timeoutMs = options.timeoutMs;
  }

  async runTurn(input: AgentTurnInput): Promise<AgentTurnResult> {
    const args = ["-p", "--output-format", "json"];
    const sessionRef = UUID_RE.test(input.sessionRef ?? "") ? input.sessionRef : undefined;
    if (sessionRef) args.push("--resume", sessionRef);
    if (this.model) args.push("--model", this.model);
    // "--" ends flag parsing: text starting with '-' would otherwise be eaten
    // as CLI flags (claude v2.1.296 verified to honor the separator).
    args.push("--", input.text);

    let result: CapturedRun;
    try {
      result = await runCaptured(this.bin, args, input.workdir, this.timeoutMs);
    } catch (err) {
      throw new Error(`could not start ${this.bin}: ${err instanceof Error ? err.message : String(err)}`);
    }

    const parsed = parseClaudeOutput(result.stdout);
    if (parsed.error) throw new Error(parsed.error);
    if (result.timedOut) throw new Error(`claude timed out after ${this.timeoutMs}ms`);
    if (result.code !== 0) throw new Error(`claude exited with code ${result.code}`);
    if (!parsed.reply) throw new Error("claude returned no reply text");
    return { reply: parsed.reply, sessionRef: parsed.sessionId ?? sessionRef };
  }
}
