import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, openSync, readSync } from "node:fs";
import { resolveBin } from "../resolve-bin.js";

const MAX_STDOUT = 16 * 1024 * 1024;

/** Windows cannot CreateProcess a shebang script. Run it with sh, which is how the tests fake a CLI. */
function shebang(bin: string): boolean {
  if (process.platform !== "win32") return false;
  let fd: number | undefined;
  try {
    fd = openSync(bin, "r");
    const buf = Buffer.alloc(2);
    const n = readSync(fd, buf, 0, 2, 0);
    return n === 2 && buf[0] === 0x23 && buf[1] === 0x21;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function start(bin: string, args: string[], cwd: string, env?: NodeJS.ProcessEnv): ChildProcess {
  const resolved = resolveBin(bin);
  const opts = {
    cwd,
    env: env ? { ...process.env, ...env } : undefined,
    stdio: ["pipe", "pipe", "pipe"] as ["pipe", "pipe", "pipe"],
    detached: process.platform !== "win32",
  };
  if (shebang(resolved)) return spawn("sh", [resolved, ...args], opts);
  return spawn(resolved, args, opts);
}

export interface LiveProcess {
  write(line: string): void;
  endInput(): void;
  kill(): void;
  pauseTimeout(): void;
  armTimeout(): void;
  /** Next stdout line, `null` when the process has exited, or `"idle"` if `idleMs` passes with no line. */
  readLine(idleMs?: number): Promise<string | null | "idle">;
  timedOut(): boolean;
  exitCode(): number | null;
  /** Spawn failure (missing binary). Undefined once the process is running. */
  startError(): Error | undefined;
}

/**
 * Spawn a CLI with stdin open so a question can be answered later.
 * Same process-group kill as `runCaptured`.
 */
export function spawnLive(
  bin: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
  env?: NodeJS.ProcessEnv,
): LiveProcess {
  let child: ChildProcess;
  try {
    child = start(bin, args, cwd, env);
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    return closed(error);
  }
  child.stderr?.on("data", () => {});

  let buf = "";
  let size = 0;
  const queue: string[] = [];
  let exited = false;
  let timedOut = false;
  let startError: Error | undefined;
  let waiter: ((line: string | null | "idle") => void) | undefined;
  let idleTimer: NodeJS.Timeout | undefined;
  let killTimer: NodeJS.Timeout | undefined;

  const kill = () => {
    if (process.platform === "win32" && child.pid) {
      try {
        child.kill();
      } catch {
        // already gone
      }
      spawn("taskkill", ["/pid", String(child.pid), "/f", "/t"], { stdio: "ignore", windowsHide: true }).on("error", () => {});
      return;
    }
    try {
      if (child.pid) process.kill(-child.pid, "SIGKILL");
    } catch {
      child.kill("SIGKILL");
    }
  };

  const armTimeout = () => {
    clearTimeout(killTimer);
    killTimer = setTimeout(() => {
      timedOut = true;
      kill();
      // A shell that ignores the signal must still unblock the reader.
      setTimeout(() => {
        if (!exited) deliver(null);
      }, 300);
    }, timeoutMs);
  };
  armTimeout();

  const deliver = (line: string | null) => {
    clearTimeout(idleTimer);
    if (waiter) {
      const w = waiter;
      waiter = undefined;
      w(line);
    } else if (line !== null) {
      queue.push(line);
    }
  };

  child.stdout?.on("data", (chunk: Buffer) => {
    if (size >= MAX_STDOUT) return;
    size += chunk.length;
    buf += chunk.toString("utf8");
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      deliver(buf.slice(0, nl).replace(/\r$/, ""));
      buf = buf.slice(nl + 1);
    }
  });

  child.on("error", (err) => {
    startError = err;
    clearTimeout(killTimer);
    deliver(null);
  });

  child.on("close", () => {
    exited = true;
    clearTimeout(killTimer);
    if (buf.trim()) deliver(buf.replace(/\r$/, ""));
    buf = "";
    deliver(null);
  });

  return {
    write(line: string) {
      try {
        child.stdin?.write(line.endsWith("\n") ? line : `${line}\n`);
      } catch {
        // process already gone
      }
    },
    endInput() {
      try {
        child.stdin?.end();
      } catch {
        // process already gone
      }
    },
    kill() {
      clearTimeout(killTimer);
      clearTimeout(idleTimer);
      kill();
    },
    pauseTimeout() {
      clearTimeout(killTimer);
    },
    armTimeout,
    timedOut: () => timedOut,
    exitCode: () => (exited ? child.exitCode : null),
    startError: () => startError,
    readLine(idleMs?: number) {
      if (startError && queue.length === 0) return Promise.reject(startError);
      if (queue.length) return Promise.resolve(queue.shift()!);
      if (exited) return Promise.resolve(null);
      return new Promise((resolve) => {
        waiter = resolve;
        if (idleMs) {
          idleTimer = setTimeout(() => {
            if (waiter !== resolve) return;
            waiter = undefined;
            resolve("idle");
          }, idleMs);
        }
      });
    },
  };
}

function closed(error: Error): LiveProcess {
  return {
    write() {},
    endInput() {},
    kill() {},
    pauseTimeout() {},
    armTimeout() {},
    timedOut: () => false,
    exitCode: () => null,
    startError: () => error,
    readLine: () => Promise.reject(error),
  };
}
