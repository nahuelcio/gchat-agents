import { join } from "node:path";
import { expect, test } from "vitest";
import { claudeCommand } from "../harness/claude-bin.ts";

const there = (path: string) => path.endsWith("claude.exe") || path.endsWith("claude.cmd");

test("a configured command wins when the file exists", () => {
  expect(claudeCommand({ PI_CLAUDE_CODE_COMMAND: "D:\\tools\\claude.exe" }, (path) => path === "D:\\tools\\claude.exe")).toBe("D:\\tools\\claude.exe");
});

test("the npm global install is used when claude is not on PATH", () => {
  const env = { APPDATA: "C:\\Users\\nahuel\\AppData\\Roaming", PATH: "C:\\Windows", PATHEXT: ".EXE;.CMD" };
  expect(claudeCommand(env, there)).toBe(join(env.APPDATA, "npm", "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe"));
});

test("the npm cmd shim resolves to claude.exe", () => {
  const npm = "C:\\Users\\nahuel\\AppData\\Roaming\\npm";
  const cmd = join(npm, "claude.CMD");
  const exe = join(npm, "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe");
  expect(claudeCommand({ PATH: npm, PATHEXT: ".CMD" }, (path) => path === cmd || path === exe)).toBe(exe);
  expect(claudeCommand({ PI_CLAUDE_CODE_COMMAND: cmd }, (path) => path === cmd || path === exe)).toBe(exe);
});
