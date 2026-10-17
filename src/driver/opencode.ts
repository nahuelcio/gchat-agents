import type { AgentDriver, AgentQuestion, AgentTurnInput, AgentTurnResult, PendingAgent } from "./types.js";
import { spawnLive, type LiveProcess } from "./live.js";
import { continuation, formatQuestions, normalizeQuestions } from "../questions.js";
import { opencodeMcpConfig, type SwitchboardMcp } from "../switchboard-mcp.js";

/** Silence after a question event before we treat the CLI as blocked on the user. */
const ASK_IDLE_MS = 200;

export interface OpenCodeDriverOptions {
  bin: string;
  /** Optional model override, "provider/model#variant". Omitted = opencode default. */
  model?: string;
  agent?: string;
  timeoutMs: number;
  /** Expose Switchboard MCP tools (link_work_item, …) for this turn. */
  switchboard?: SwitchboardMcp;
}

export interface ParsedRunOutput {
  reply: string;
  sessionId?: string;
  error?: string;
  questions?: AgentQuestion[];
}

export interface RunLine {
  text?: string;
  sessionId?: string;
  error?: string;
  questions?: AgentQuestion[];
  /** Question tool is blocked on the user (not a completed tool call). */
  asking?: boolean;
}

/**
 * Parse `opencode run --format json` NDJSON output.
 * Verified against opencode v2.0.26: each line is
 *   {"type":"text","sessionID":"ses_…","part":{"type":"text","text":"…"}}
 * and failures appear as {"type":"error","error":{"message":"…"}} with exit code 1.
 */
/** One NDJSON line from `opencode run --format json`. */
export function parseRunLine(line: string): RunLine {
  const trimmed = line.trim();
  if (!trimmed) return {};
  let obj: {
    type?: string;
    sessionID?: string;
    questions?: unknown;
    properties?: { part?: { type?: string; text?: string; tool?: string; state?: { status?: string; input?: { questions?: unknown } } } };
    part?: { type?: string; text?: string; tool?: string; state?: { status?: string; input?: { questions?: unknown } } };
    error?: { message?: string };
  };
  try {
    obj = JSON.parse(trimmed) as typeof obj;
  } catch {
    return {};
  }
  const sessionId = typeof obj.sessionID === "string" && obj.sessionID ? obj.sessionID : undefined;
  if (obj.type === "error" && obj.error) {
    return { sessionId, error: obj.error.message ?? JSON.stringify(obj.error) };
  }
  if (obj.type === "question") {
    const questions = normalizeQuestions(obj.questions);
    return questions.length ? { sessionId, questions, asking: true } : { sessionId };
  }
  const part = obj.part ?? obj.properties?.part;
  if ((obj.type === "text" || part?.type === "text") && part?.type === "text" && typeof part.text === "string") {
    return { sessionId, text: part.text };
  }
  if (part?.type === "tool" && part.tool === "question") {
    const questions = normalizeQuestions(part.state?.input?.questions);
    if (!questions.length) return { sessionId };
    const done = part.state?.status === "completed" || part.state?.status === "error";
    return { sessionId, questions, asking: !done };
  }
  return { sessionId };
}

export function parseRunOutput(stdout: string): ParsedRunOutput {
  let reply = "";
  let sessionId: string | undefined;
  let error: string | undefined;
  let questions: AgentQuestion[] | undefined;
  for (const line of stdout.split("\n")) {
    const parsed = parseRunLine(line);
    if (parsed.sessionId) sessionId = parsed.sessionId;
    if (parsed.text) reply += parsed.text;
    if (parsed.error) error = parsed.error;
    if (parsed.asking && parsed.questions) questions = parsed.questions;
  }
  return { reply, sessionId, error, ...(questions && { questions }) };
}

/**
 * Runs one agent turn by spawning the real opencode CLI:
 *   opencode run --format json [--session <id>] -- <text>   (cwd = workdir)
 * `--session` continues the session, creating it if it does not exist (v2.0.26).
 */
export class OpenCodeDriver implements AgentDriver {
  private bin: string;
  private model?: string;
  private agent?: string;
  private timeoutMs: number;
  private switchboard?: SwitchboardMcp;

  constructor(options: OpenCodeDriverOptions) {
    this.bin = options.bin;
    this.model = options.model;
    this.agent = options.agent;
    this.timeoutMs = options.timeoutMs;
    this.switchboard = options.switchboard;
  }

  async runTurn(input: AgentTurnInput): Promise<AgentTurnResult> {
    const live = this.spawn(input);
    live.endInput();
    try {
      return await this.pump(live, input, "");
    } catch (err) {
      if (live.startError()) {
        throw new Error(`could not start ${this.bin}: ${err instanceof Error ? err.message : String(err)}`);
      }
      throw err;
    }
  }

  private spawn(input: AgentTurnInput): LiveProcess {
    const args = ["run", "--format", "json"];
    // opencode rejects session ids not starting with "ses"; a stale or foreign
    // ref (e.g. from another driver) means: start a fresh session.
    const sessionRef = /^ses_/.test(input.sessionRef ?? "") ? input.sessionRef : undefined;
    if (sessionRef) args.push("--session", sessionRef);
    const model = input.model ?? this.model;
    if (model) args.push("--model", model);
    const agent = input.agent ?? this.agent;
    if (agent) args.push("--agent", agent);
    // "--" ends flag parsing: text starting with '-' would otherwise be eaten
    // as CLI flags (opencode v2.0.26 verified to honor the separator).
    args.push("--", input.text);
    const env = this.switchboard
      ? { OPENCODE_CONFIG_CONTENT: opencodeMcpConfig(this.switchboard.serverPath, input.threadKey, this.switchboard.adminUrl) }
      : undefined;
    return spawnLive(this.bin, args, input.workdir, this.timeoutMs, env);
  }

  private async pump(live: LiveProcess, input: AgentTurnInput, preface: string): Promise<AgentTurnResult> {
    let reply = "";
    let sessionRef = /^ses_/.test(input.sessionRef ?? "") ? input.sessionRef : undefined;
    let asking: AgentQuestion[] | undefined;
    for (;;) {
      const line = await live.readLine(asking ? ASK_IDLE_MS : undefined);
      if (line === "idle" && asking) {
        if (input.answerQuestions === false) {
          asking = undefined;
          continue;
        }
        live.pauseTimeout();
        const questions = asking;
        const pending: PendingAgent = {
          questions,
          cancel: () => live.kill(),
          resume: async (answer: string) => {
            return this.runTurn({ ...input, sessionRef, text: continuation(questions, answer) });
          },
        };
        const shown = [`${preface}${reply}`.trim(), formatQuestions(questions)].filter(Boolean).join("\n\n");
        return { reply: shown, sessionRef, pending };
      }
      if (line === null || line === "idle") {
        if (live.timedOut()) throw new Error(`opencode timed out after ${this.timeoutMs}ms`);
        if (live.startError()) throw live.startError();
        if (asking) {
          const questions = asking;
          if (input.answerQuestions === false) {
            return { reply: `${preface}${reply}`.trim() || formatQuestions(questions), sessionRef };
          }
          const pending: PendingAgent = {
            questions,
            cancel: () => {},
            resume: (answer: string) => this.runTurn({ ...input, sessionRef, text: continuation(questions, answer) }),
          };
          return { reply: formatQuestions(questions), sessionRef, pending };
        }
        const code = live.exitCode();
        if (code !== 0 && code !== null) throw new Error(`opencode exited with code ${code}`);
        if (!reply && !preface) throw new Error("opencode returned no reply text");
        return { reply: preface + reply, sessionRef };
      }
      const parsed = parseRunLine(line);
      if (parsed.sessionId) sessionRef = parsed.sessionId;
      if (parsed.error) throw new Error(parsed.error);
      if (parsed.asking && parsed.questions) {
        asking = parsed.questions;
        continue;
      }
      if (parsed.questions && !parsed.asking) asking = undefined;
      if (parsed.text) reply += parsed.text;
    }
  }
}
