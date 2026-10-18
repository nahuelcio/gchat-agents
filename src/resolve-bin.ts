import { existsSync, openSync, closeSync, readSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, delimiter } from "node:path";

/** True when `path` is a Windows PE executable (MZ header). */
function isPeExe(path: string): boolean {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const buf = Buffer.alloc(2);
    const n = readSync(fd, buf, 0, 2, 0);
    return n === 2 && buf[0] === 0x4d && buf[1] === 0x5a; // "MZ"
  } catch {
    return false;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/**
 * npm global shims on Windows are `name.cmd` that Invoke a real `.exe`.
 * Node 20+ refuses to CreateProcess `.cmd` without `shell: true` (EINVAL), and
 * the extensionless `name` shim is a shebang script — also unspawnable.
 * Pull the nested `.exe` path out of the `.cmd` when present.
 */
function exeFromCmd(cmdPath: string): string | undefined {
  let text: string;
  try {
    text = readFileSync(cmdPath, "utf8");
  } catch {
    return undefined;
  }
  const dir = dirname(cmdPath);
  for (const re of [/"%dp0%\\([^"]+\.exe)"/i, /"%~dp0\\([^"]+\.exe)"/i]) {
    const rel = text.match(re)?.[1];
    if (!rel) continue;
    const resolved = join(dir, rel);
    if (existsSync(resolved)) return resolved;
  }
  // Absolute quoted path to an .exe
  const abs = text.match(/"([A-Za-z]:\\[^"]+\.exe)"/)?.[1];
  if (abs && existsSync(abs)) return abs;
  return undefined;
}

/**
 * Resolve a CLI name to something Node can spawn without a shell.
 * On Windows, prefers a real `.exe` over npm's `.cmd` / shebang shims.
 * On other platforms, returns `bin` unchanged.
 */
export function resolveBin(bin: string, pathEnv: string = process.env.PATH ?? "", platform: NodeJS.Platform = process.platform): string {
  if (platform !== "win32") return bin;
  // Already a path or an explicit executable — leave alone.
  if (isAbsolute(bin) || bin.includes("/") || bin.includes("\\") || /\.(exe|com)$/i.test(bin)) return bin;

  for (const dir of pathEnv.split(delimiter).filter(Boolean)) {
    const exe = join(dir, `${bin}.exe`);
    if (existsSync(exe)) return exe;

    const cmd = join(dir, `${bin}.cmd`);
    if (existsSync(cmd)) {
      const nested = exeFromCmd(cmd);
      if (nested) return nested;
    }

    const bare = join(dir, bin);
    if (existsSync(bare) && isPeExe(bare)) return bare;
  }
  return bin;
}
