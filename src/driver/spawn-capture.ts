import { spawn } from "node:child_process";
import { resolveBin } from "../resolve-bin.js";

export interface CapturedRun {
  code: number | null;
  stdout: string;
  timedOut: boolean;
}

const MAX_STDOUT = 16 * 1024 * 1024;

/**
 * Spawn argv in cwd and capture stdout. Shared by every AgentDriver adapter:
 * - stdin ignored: the agent must never wait for input it cannot get.
 * - detached: on timeout, kill the whole process group — agents spawn children
 *   (background services) that would otherwise keep pipes open.
 */
export function runCaptured(
  bin: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
): Promise<CapturedRun> {
  return new Promise((resolve, reject) => {
    const child = spawn(resolveBin(bin), args, { cwd, stdio: ["ignore", "pipe", "pipe"], detached: true });
    let stdout = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (child.pid) process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL"); // group already gone
      }
    }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      if (stdout.length < MAX_STDOUT) stdout += chunk.toString("utf8");
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, timedOut });
    });
  });
}
