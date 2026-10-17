import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { ClaudeDriver, interpretClaudeLine, parseClaudeOutput } from "../src/driver/claude.js";

describe("parseClaudeOutput", () => {
  it("extracts reply and session id from a success result", () => {
    const parsed = parseClaudeOutput(
      JSON.stringify({
        type: "result",
        subtype: "success",
        result: "OK",
        session_id: "3113400e-a4f2-4bae-9eae-94df1490de60",
        is_error: false,
      }),
    );
    expect(parsed.reply).toBe("OK");
    expect(parsed.sessionId).toBe("3113400e-a4f2-4bae-9eae-94df1490de60");
    expect(parsed.error).toBeUndefined();
  });

  it("treats is_error as an error even when subtype says success (seen live on v2.1.296)", () => {
    const parsed = parseClaudeOutput(
      JSON.stringify({
        type: "result",
        subtype: "success",
        is_error: true,
        result: "Failed to authenticate: OAuth session expired",
        session_id: "3113400e-a4f2-4bae-9eae-94df1490de60",
      }),
    );
    expect(parsed.reply).toBe("");
    expect(parsed.error).toBe("Failed to authenticate: OAuth session expired");
  });

  it("reports context usage of the main model: input + cache tokens over its context window", () => {
    const parsed = parseClaudeOutput(
      JSON.stringify({
        type: "result",
        result: "ok",
        session_id: "3113400e-a4f2-4bae-9eae-94df1490de60",
        is_error: false,
        usage: { input_tokens: 2, cache_creation_input_tokens: 62631, cache_read_input_tokens: 1000, output_tokens: 4 },
        modelUsage: {
          "claude-haiku-5-5": { inputTokens: 1156, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, contextWindow: 200000 },
          "claude-opus-5-5": { inputTokens: 2, cacheCreationInputTokens: 62631, cacheReadInputTokens: 1000, contextWindow: 1000000 },
        },
      }),
    );
    expect(parsed.usage).toEqual({ contextTokens: 63633, contextWindow: 1000000 });
  });

  it("flags unparseable and non-result output as errors", () => {
    expect(parseClaudeOutput("not json").error).toBeTruthy();
    expect(parseClaudeOutput(JSON.stringify({ type: "assistant" })).error).toBeTruthy();
  });
});

describe("interpretClaudeLine", () => {
  it("pulls AskUserQuestion out of a control request and ignores other tools", () => {
    const question = interpretClaudeLine(
      JSON.stringify({
        type: "control_request",
        request_id: "r1",
        request: {
          subtype: "can_use_tool",
          tool_name: "AskUserQuestion",
          input: {
            questions: [
              {
                question: "Which library?",
                header: "Library",
                options: [
                  { label: "date-fns", description: "small" },
                  { label: "luxon", description: "tz" },
                ],
                multiSelect: false,
              },
            ],
          },
        },
      }),
    );
    expect(question).toMatchObject({ kind: "question", requestId: "r1" });
    expect(interpretClaudeLine(JSON.stringify({ type: "control_request", request_id: "r2", request: { subtype: "can_use_tool", tool_name: "Bash", input: {} } }))).toEqual({
      kind: "permission",
      requestId: "r2",
    });
  });
});

describe("ClaudeDriver argv", () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "gchat-claude-"));
  });

  async function fakeBin(name: string, script: string): Promise<string> {
    const path = join(dir, name);
    await writeFile(path, script, "utf8");
    await chmod(path, 0o755);
    return path;
  }

  it("spawns claude with -p, json output and end-of-flags separator", async () => {
    const argsFile = join(dir, "args.txt");
    const bin = await fakeBin(
      "claude-args.sh",
      `#!/bin/sh\necho "$@" > ${JSON.stringify(argsFile)}\n` +
        `echo '{"type":"result","result":"hi","session_id":"3113400e-a4f2-4bae-9eae-94df1490de60","is_error":false}'\n`,
    );
    const driver = new ClaudeDriver({ bin, timeoutMs: 10_000 });
    const result = await driver.runTurn({ threadKey: "t", text: "hello", workdir: dir });

    const args = (await readFile(argsFile, "utf8")).split(/\s+/).filter(Boolean);
    expect(args).toEqual([
      "-p",
      "--output-format",
      "stream-json",
      "--input-format",
      "stream-json",
      "--verbose",
      "--permission-prompts",
      "host",
    ]);
    expect(result).toEqual({
      reply: "hi",
      sessionRef: "3113400e-a4f2-4bae-9eae-94df1490de60",
    });
  });

  it("resumes only UUID refs, honors the model flag, and starts fresh on foreign refs", async () => {
    const argsFile = join(dir, "args2.txt");
    const bin = await fakeBin(
      "claude-args2.sh",
      `#!/bin/sh\necho "$@" >> ${JSON.stringify(argsFile)}\n` +
        `echo '{"type":"result","result":"ok","session_id":"3113400e-a4f2-4bae-9eae-94df1490de60","is_error":false}'\n`,
    );
    const driver = new ClaudeDriver({ bin, model: "claude-sonnet-4-5", timeoutMs: 10_000 });

    await driver.runTurn({
      threadKey: "t",
      sessionRef: "3113400e-a4f2-4bae-9eae-94df1490de60",
      text: "a",
      workdir: dir,
    });
    await driver.runTurn({
      threadKey: "t",
      sessionRef: "ses_foreign",
      text: "b",
      workdir: dir,
    });

    const lines = (await readFile(argsFile, "utf8")).trim().split("\n");
    expect(lines[0]?.split(/\s+/)).toEqual([
      "-p",
      "--output-format",
      "stream-json",
      "--input-format",
      "stream-json",
      "--verbose",
      "--permission-prompts",
      "host",
      "--resume",
      "3113400e-a4f2-4bae-9eae-94df1490de60",
      "--model",
      "claude-sonnet-4-5",
    ]);
    expect(lines[1]?.split(/\s+/)).toEqual([
      "-p",
      "--output-format",
      "stream-json",
      "--input-format",
      "stream-json",
      "--verbose",
      "--permission-prompts",
      "host",
      "--model",
      "claude-sonnet-4-5",
    ]);
  });

  it("parks on AskUserQuestion and continues when the thread answers", async () => {
    const answerFile = join(dir, "answer.txt");
    const bin = await fakeBin(
      "claude-ask.sh",
      `#!/bin/sh\nread line\n` +
        `echo '{"type":"control_request","request_id":"r1","request":{"subtype":"can_use_tool","tool_name":"AskUserQuestion","input":{"questions":[{"question":"Which library?","header":"Library","options":[{"label":"date-fns","description":"small"},{"label":"luxon","description":"tz"}],"multiSelect":false}]}}}'\n` +
        `while read line; do\n` +
        `  case "$line" in\n` +
        `    *control_response*) echo "$line" > ${JSON.stringify(answerFile)}; echo '{"type":"result","result":"Using it","session_id":"3113400e-a4f2-4bae-9eae-94df1490de60","is_error":false}'; exit 0;;\n` +
        `  esac\n` +
        `done\n`,
    );
    const driver = new ClaudeDriver({ bin, timeoutMs: 10_000 });
    const parked = await driver.runTurn({ threadKey: "t", text: "pick one", workdir: dir });
    expect(parked.pending?.questions[0]?.question).toBe("Which library?");
    const done = await parked.pending!.resume("1");
    expect(done.reply).toBe("Using it");
    expect(await readFile(answerFile, "utf8")).toContain("date-fns");
  });

  it("surfaces is_error results as turn errors", async () => {
    const bin = await fakeBin(
      "claude-err.sh",
      `#!/bin/sh\n` +
        `echo '{"type":"result","subtype":"success","is_error":true,"result":"Failed to authenticate","session_id":"3113400e-a4f2-4bae-9eae-94df1490de60"}'\n`,
    );
    const driver = new ClaudeDriver({ bin, timeoutMs: 10_000 });
    await expect(driver.runTurn({ threadKey: "t", text: "x", workdir: dir })).rejects.toThrow(
      /Failed to authenticate/,
    );
  });
});
