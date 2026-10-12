import type { AgentDriver, AgentTurnInput, AgentTurnResult } from "./types.js";
import { runCaptured, type CapturedRun } from "./spawn-capture.js";

export interface OpenCodeDriverOptions {
  bin: string;
  /** Optional model override, "provider/model#variant". Omitted = opencode default. */
  model?: string;
  timeoutMs: number;
}

export interface ParsedRunOutput {
  reply: string;
  sessionId?: string;
  error?: string;
}

/**
 * Parse `opencode run --format json` NDJSON output.
 * Verified against opencode v2.0.26: each line is
 *   {"type":"text","sessionID":"ses_…","part":{"type":"text","text":"…"}}
 * and failures appear as {"type":"error","error":{"message":"…"}} with exit code 1.
 */
export function parseRunOutput(stdout: string): ParsedRunOutput {
  let reply = "";
  let sessionId: string | undefined;
  let error: string | undefined;
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let obj: {
      type?: string;
      sessionID?: string;
      part?: { type?: string; text?: string };
      error?: { message?: string };
    };
    try {
      obj = JSON.parse(trimmed) as typeof obj;
    } catch {
      continue; // not JSON: ignore
    }
    if (typeof obj.sessionID === "string" && obj.sessionID) sessionId = obj.sessionID;
    if (obj.type === "text" && obj.part?.type === "text" && typeof obj.part.text === "string") {
      reply += obj.part.text;
    }
    if (obj.type === "error" && obj.error) {
      error = obj.error.message ?? JSON.stringify(obj.error);
    }
  }
  return { reply, sessionId, error };
}

/**
 * Runs one agent turn by spawning the real opencode CLI:
 *   opencode run --format json [--session <id>] -- <text>   (cwd = workdir)
 * `--session` continues the session, creating it if it does not exist (v2.0.26).
 */
export class OpenCodeDriver implements AgentDriver {
  private bin: string;
  private model?: string;
  private timeoutMs: number;

  constructor(options: OpenCodeDriverOptions) {
    this.bin = options.bin;
    this.model = options.model;
    this.timeoutMs = options.timeoutMs;
  }

  async runTurn(input: AgentTurnInput): Promise<AgentTurnResult> {
    const args = ["run", "--format", "json"];
    // opencode rejects session ids not starting with "ses"; a stale or foreign
    // ref (e.g. from another driver) means: start a fresh session.
    const sessionRef = /^ses_/.test(input.sessionRef ?? "") ? input.sessionRef : undefined;
    if (sessionRef) args.push("--session", sessionRef);
    if (this.model) args.push("--model", this.model);
    // "--" ends flag parsing: text starting with '-' would otherwise be eaten
    // as CLI flags (opencode v2.0.26 verified to honor the separator).
    args.push("--", input.text);

    let result: CapturedRun;
    try {
      result = await runCaptured(this.bin, args, input.workdir, this.timeoutMs);
    } catch (err) {
      throw new Error(`could not start ${this.bin}: ${err instanceof Error ? err.message : String(err)}`);
    }

    const parsed = parseRunOutput(result.stdout);
    if (parsed.error) throw new Error(parsed.error);
    if (result.timedOut) throw new Error(`opencode timed out after ${this.timeoutMs}ms`);
    if (result.code !== 0) throw new Error(`opencode exited with code ${result.code}`);
    if (!parsed.reply) throw new Error("opencode returned no reply text");
    return { reply: parsed.reply, sessionRef: parsed.sessionId ?? sessionRef };
  }
}
