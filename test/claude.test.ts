import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { ClaudeDriver, parseClaudeOutput } from "../src/driver/claude.js";

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

  it("flags unparseable and non-result output as errors", () => {
    expect(parseClaudeOutput("not json").error).toBeTruthy();
    expect(parseClaudeOutput(JSON.stringify({ type: "assistant" })).error).toBeTruthy();
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
    expect(args).toEqual(["-p", "--output-format", "json", "--", "hello"]);
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
      "json",
      "--resume",
      "3113400e-a4f2-4bae-9eae-94df1490de60",
      "--model",
      "claude-sonnet-4-5",
      "--",
      "a",
    ]);
    expect(lines[1]?.split(/\s+/)).toEqual([
      "-p",
      "--output-format",
      "json",
      "--model",
      "claude-sonnet-4-5",
      "--",
      "b",
    ]);
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
