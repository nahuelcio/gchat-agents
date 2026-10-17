import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { OpenCodeDriver, parseRunOutput } from "../src/driver/opencode.js";

// Shapes captured from a real `opencode run --format json` (v2.0.26).
describe("parseRunOutput", () => {
  it("concatenates text parts and extracts the session id", () => {
    const stdout = [
      JSON.stringify({
        type: "step_start",
        timestamp: 1,
        sessionID: "ses_ed1c15714ffenWYippziRKFbtt",
        part: { id: "prt_1", sessionID: "ses_ed1c15714ffenWYippziRKFbtt", type: "step-start" },
      }),
      JSON.stringify({
        type: "text",
        sessionID: "ses_ed1c15714ffenWYippziRKFbtt",
        part: { id: "prt_2", type: "text", text: "Hello " },
      }),
      JSON.stringify({
        type: "text",
        sessionID: "ses_ed1c15714ffenWYippziRKFbtt",
        part: { id: "prt_3", type: "text", text: "world" },
      }),
      JSON.stringify({ type: "step_finish", sessionID: "ses_ed1c15714ffenWYippziRKFbtt" }),
    ].join("\n");
    expect(parseRunOutput(stdout)).toEqual({
      reply: "Hello world",
      sessionId: "ses_ed1c15714ffenWYippziRKFbtt",
    });
  });

  it("surfaces error lines", () => {
    const stdout = JSON.stringify({
      type: "error",
      timestamp: 1,
      sessionID: "ses_x",
      error: { type: "provider.auth", message: "Upstream request failed", status: 403 },
    });
    expect(parseRunOutput(stdout)).toEqual({
      reply: "",
      sessionId: "ses_x",
      error: "Upstream request failed",
    });
  });

  it("ignores non-JSON lines and empty output", () => {
    expect(parseRunOutput("not json\n\n")).toEqual({ reply: "" });
  });
});

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "gchat-ocdriver-"));
});

async function fakeBin(name: string, script: string): Promise<string> {
  const path = join(dir, name);
  await writeFile(path, script, { mode: 0o755 });
  await chmod(path, 0o755);
  return path;
}

describe("OpenCodeDriver (spawned against a fake CLI)", () => {
  it("runs the CLI, parses the reply, and returns the session id", async () => {
    const argsFile = join(dir, "args.txt");
    const bin = await fakeBin(
      "oc-reply.sh",
      `#!/bin/sh\necho "$@" > ${JSON.stringify(argsFile)}\n` +
        `echo '{"type":"text","sessionID":"ses_ok123","part":{"type":"text","text":"Hi there"}}'\n`,
    );
    const driver = new OpenCodeDriver({ bin, timeoutMs: 10_000 });
    const result = await driver.runTurn({ threadKey: "t", text: "hello", workdir: dir });
    expect(result).toEqual({ reply: "Hi there", sessionRef: "ses_ok123" });

    const args = (await readFile(argsFile, "utf8")).split(/\s+/).filter(Boolean);
    expect(args).toEqual(["run", "--format", "json", "--", "hello"]);
  });

  it("continues with --session for ses_ refs and starts fresh otherwise", async () => {
    const argsFile = join(dir, "args.txt");
    const bin = await fakeBin(
      "oc-args.sh",
      `#!/bin/sh\necho "$@" >> ${JSON.stringify(argsFile)}\n` +
        `echo '{"type":"text","sessionID":"ses_new","part":{"type":"text","text":"ok"}}'\n`,
    );
    const driver = new OpenCodeDriver({ bin, timeoutMs: 10_000 });
    await driver.runTurn({ threadKey: "t", sessionRef: "ses_keep", text: "a", workdir: dir });
    await driver.runTurn({ threadKey: "t", sessionRef: "echo-thread-1", text: "b", workdir: dir });

    const lines = (await readFile(argsFile, "utf8")).trim().split("\n");
    expect(lines[0]?.split(/\s+/)).toEqual(["run", "--format", "json", "--session", "ses_keep", "--", "a"]);
    expect(lines[1]?.split(/\s+/)).toEqual(["run", "--format", "json", "--", "b"]);
  });

  it("surfaces NDJSON error lines from a nonzero exit", async () => {
    const bin = await fakeBin(
      "oc-fail.sh",
      `#!/bin/sh\necho '{"type":"error","error":{"message":"Upstream request failed"}}'\nexit 1\n`,
    );
    const driver = new OpenCodeDriver({ bin, timeoutMs: 10_000 });
    await expect(driver.runTurn({ threadKey: "t", text: "x", workdir: dir })).rejects.toThrow(
      "Upstream request failed",
    );
  });

  it("rejects with a timeout message when the CLI hangs", async () => {
    const bin = await fakeBin("oc-slow.sh", "#!/bin/sh\nsleep 30\n");
    const driver = new OpenCodeDriver({ bin, timeoutMs: 150 });
    await expect(
      driver.runTurn({ threadKey: "t", text: "x", workdir: dir }),
    ).rejects.toThrow("opencode timed out after 150ms");
  }, 5000);

  it("parks when a question event goes quiet and feeds the answer back on stdin", async () => {
    const answerFile = join(dir, "answer.txt");
    const bin = await fakeBin(
      "oc-ask.sh",
      `#!/bin/sh\n` +
        `echo '{"type":"question","sessionID":"ses_q","questions":[{"question":"Which library?","header":"Library","options":[{"label":"date-fns","description":"small"},{"label":"luxon","description":"tz"}]}]}'\n` +
        `read line\n` +
        `echo "$line" > ${JSON.stringify(answerFile)}\n` +
        `echo '{"type":"text","sessionID":"ses_q","part":{"type":"text","text":"noted"}}'\n`,
    );
    const driver = new OpenCodeDriver({ bin, timeoutMs: 10_000 });
    const parked = await driver.runTurn({ threadKey: "t", text: "pick", workdir: dir });
    expect(parked.reply).toContain("Which library?");
    expect(parked.pending?.questions).toHaveLength(1);
    const done = await parked.pending!.resume("luxon");
    expect(done.reply).toContain("noted");
    expect(await readFile(answerFile, "utf8")).toContain("luxon");
  });

  it("reports a missing binary clearly", async () => {
    const driver = new OpenCodeDriver({ bin: join(dir, "no-such-bin"), timeoutMs: 10_000 });
    await expect(driver.runTurn({ threadKey: "t", text: "x", workdir: dir })).rejects.toThrow(
      /could not start/,
    );
  });
});
