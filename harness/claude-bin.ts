import { accessSync, constants } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";

function fileExists(path: string) {
  try {
    accessSync(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

const SHIM = /\.(?:cmd|bat)$/i;

function nativeBinary(path: string, exists: (path: string) => boolean) {
  if (!SHIM.test(path)) return exists(path) ? path : undefined;
  const exe = join(dirname(path), "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe");
  return exists(exe) ? exe : undefined;
}

function pathHit(env: NodeJS.ProcessEnv, exists: (path: string) => boolean) {
  const exts = process.platform === "win32" ? (env.PATHEXT || ".COM;.EXE;.BAT;.CMD").split(";") : [""];
  for (const dir of (env.PATH || "").split(delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = join(dir, `claude${ext}`);
      if (exists(candidate)) return candidate;
    }
  }
  return undefined;
}

export function claudeCommand(env: NodeJS.ProcessEnv, exists: (path: string) => boolean = fileExists) {
  const configured = env.PI_CLAUDE_CODE_COMMAND?.trim();
  if (configured) {
    const native = nativeBinary(configured, exists);
    if (native) return native;
  }
  const onPath = pathHit(env, exists);
  if (onPath) {
    const native = nativeBinary(onPath, exists);
    if (native) return native;
  }
  const home = env.HOME || env.USERPROFILE || homedir();
  const candidates = [
    env.APPDATA && join(env.APPDATA, "npm", "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe"),
    env.APPDATA && join(env.APPDATA, "npm", "claude.cmd"),
    join(home, ".npm-global", "bin", "claude"),
    join(home, ".local", "bin", "claude"),
    "/usr/local/bin/claude",
    "/opt/homebrew/bin/claude",
  ];
  for (const path of candidates) {
    if (!path) continue;
    const native = nativeBinary(path, exists);
    if (native) return native;
  }
}

export function ensureClaudeCommand() {
  const found = claudeCommand(process.env);
  if (!found) return;
  process.env.PI_CLAUDE_CODE_COMMAND = found;
  const dir = dirname(found);
  const path = process.env.PATH || "";
  if (!path.split(delimiter).includes(dir)) process.env.PATH = `${dir}${delimiter}${path}`;
}
