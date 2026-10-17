import type { AgentDriver, AgentQuestion, AgentTurnInput, AgentTurnResult, ContextUsage, PendingAgent } from "./types.js";
import { spawnLive, type LiveProcess } from "./live.js";
import { answersFromText, formatQuestions, normalizeQuestions } from "../questions.js";

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
  usage?: ContextUsage;
}

interface ModelUsage {
  inputTokens?: number;
  cacheCreationInputTokens?: number;
  cacheReadInputTokens?: number;
  contextWindow?: number;
}

/**
 * Context size after the turn = prompt tokens incl. cache (output joins the next prompt anyway).
 * modelUsage lists helper models too (e.g. haiku for titles): the window is the busiest model's.
 */
function contextUsage(
  usage: { input_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number } | undefined,
  modelUsage: Record<string, ModelUsage> | undefined,
): ContextUsage | undefined {
  if (!usage) return undefined;
  const contextTokens =
    (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0);
  const size = (m: ModelUsage) => (m.inputTokens ?? 0) + (m.cacheCreationInputTokens ?? 0) + (m.cacheReadInputTokens ?? 0);
  const main = Object.values(modelUsage ?? {}).sort((a, b) => size(b) - size(a))[0];
  return { contextTokens, ...(main?.contextWindow && { contextWindow: main.contextWindow }) };
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
    usage?: { input_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number };
    modelUsage?: Record<string, ModelUsage>;
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
    usage: contextUsage(obj.usage, obj.modelUsage),
  };
}

export type ClaudeStreamEvent =
  | { kind: "ignore" }
  | { kind: "result"; parsed: ParsedClaudeOutput }
  | { kind: "question"; requestId: string; questions: AgentQuestion[] }
  | { kind: "permission"; requestId: string };

/** One NDJSON line from `claude -p --output-format stream-json`. */
export function interpretClaudeLine(line: string): ClaudeStreamEvent {
  const trimmed = line.trim();
  if (!trimmed) return { kind: "ignore" };
  let obj: {
    type?: string;
    request_id?: string;
    request?: { subtype?: string; tool_name?: string; input?: { questions?: unknown } };
  };
  try {
    obj = JSON.parse(trimmed) as typeof obj;
  } catch {
    return { kind: "ignore" };
  }
  if (obj.type === "result") return { kind: "result", parsed: parseClaudeOutput(trimmed) };
  if (obj.type === "control_request" && obj.request?.subtype === "can_use_tool" && obj.request_id) {
    if (obj.request.tool_name === "AskUserQuestion") {
      const questions = normalizeQuestions(obj.request.input?.questions);
      if (questions.length) return { kind: "question", requestId: obj.request_id, questions };
    }
    return { kind: "permission", requestId: obj.request_id };
  }
  return { kind: "ignore" };
}

function controlResponse(requestId: string, response: Record<string, unknown>): string {
  return JSON.stringify({ type: "control_response", response: { subtype: "success", request_id: requestId, response } });
}

function userMessage(text: string): string {
  return JSON.stringify({ type: "user", message: { role: "user", content: text } });
}

/**
 * Runs one agent turn by spawning the real claude CLI with stream-json so an
 * AskUserQuestion can be shown in chat and answered on stdin. Every other
 * permission prompt is denied — chat does not grant write or exec.
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
    const args = ["-p", "--output-format", "stream-json", "--input-format", "stream-json", "--verbose", "--permission-prompts", "host"];
    const sessionRef = UUID_RE.test(input.sessionRef ?? "") ? input.sessionRef : undefined;
    if (sessionRef) args.push("--resume", sessionRef);
    const model = input.model ?? this.model;
    if (model) args.push("--model", model);
    const live = spawnLive(this.bin, args, input.workdir, this.timeoutMs);
    live.write(userMessage(input.text));
    try {
      return await this.pump(live, input, sessionRef);
    } catch (err) {
      if (live.startError()) {
        throw new Error(`could not start ${this.bin}: ${err instanceof Error ? err.message : String(err)}`);
      }
      throw err;
    }
  }

  private async pump(live: LiveProcess, input: AgentTurnInput, sessionRef?: string): Promise<AgentTurnResult> {
    let reply = "";
    let usage: ContextUsage | undefined;
    for (;;) {
      const line = await live.readLine();
      if (line === "idle") continue;
      if (line === null) {
        if (live.timedOut()) throw new Error(`claude timed out after ${this.timeoutMs}ms`);
        if (live.startError()) throw live.startError();
        const code = live.exitCode();
        if (code !== 0 && code !== null) throw new Error(`claude exited with code ${code}`);
        if (!reply) throw new Error("claude returned no reply text");
        return { reply, sessionRef, ...(usage && { usage }) };
      }
      const event = interpretClaudeLine(line);
      if (event.kind === "permission" || (event.kind === "question" && input.answerQuestions === false)) {
        const requestId = event.kind === "permission" ? event.requestId : event.requestId;
        live.write(controlResponse(requestId, { behavior: "deny", message: "Denied from chat. Only clarifying questions are answered here." }));
        continue;
      }
      if (event.kind === "question") {
        live.pauseTimeout();
        const questions = event.questions;
        const pending: PendingAgent = {
          questions,
          cancel: () => live.kill(),
          resume: async (answer: string) => {
            live.armTimeout();
            live.write(
              controlResponse(event.requestId, {
                behavior: "allow",
                updatedInput: { questions, answers: answersFromText(questions, answer) },
              }),
            );
            return this.pump(live, input, sessionRef);
          },
        };
        return { reply: formatQuestions(questions), sessionRef, pending };
      }
      if (event.kind === "result") {
        if (event.parsed.error) throw new Error(event.parsed.error);
        reply = event.parsed.reply;
        usage = event.parsed.usage;
        sessionRef = event.parsed.sessionId ?? sessionRef;
        live.pauseTimeout();
        live.endInput();
        if (!reply) throw new Error("claude returned no reply text");
        return { reply, sessionRef, ...(usage && { usage }) };
      }
    }
  }
}
