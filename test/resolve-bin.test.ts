import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it, afterEach } from "vitest";
import { resolveBin } from "../src/resolve-bin.js";

const dirs: string[] = [];

function scratch(): string {
  const dir = join(tmpdir(), `resolve-bin-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("resolveBin", () => {
  it("leaves names unchanged off Windows", () => {
    expect(resolveBin("claude", "C:\\fake", "linux")).toBe("claude");
  });

  it("prefers a real .exe on PATH over a same-named shim", () => {
    const dir = scratch();
    writeFileSync(join(dir, "opencode.exe"), "MZ fake");
    writeFileSync(join(dir, "opencode.cmd"), "@echo off\n");
    expect(resolveBin("opencode", dir, "win32")).toBe(join(dir, "opencode.exe"));
  });

  it("follows an npm .cmd shim to its nested .exe", () => {
    const dir = scratch();
    const nested = join(dir, "node_modules", "@anthropic-ai", "claude-code", "bin");
    mkdirSync(nested, { recursive: true });
    const exe = join(nested, "claude.exe");
    writeFileSync(exe, "MZ fake");
    writeFileSync(
      join(dir, "claude.cmd"),
      '@ECHO off\n"%dp0%\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe"   %*\n',
    );
    // Extensionless shebang shim that Node would otherwise pick first
    writeFileSync(join(dir, "claude"), "#!/bin/sh\nexec true\n");
    expect(resolveBin("claude", dir, "win32")).toBe(exe);
  });

  it("returns the bare name when nothing is found", () => {
    expect(resolveBin("missing-cli", scratch(), "win32")).toBe("missing-cli");
  });
});
