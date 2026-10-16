import { spawn } from "node:child_process";

export type RunFn = (bin: string, args: string[]) => Promise<string>;

/**
 * Resolves on the child's `exit`, not on its pipes closing: `route add` may start
 * opentunnel's background service, which can inherit the pipes and keep them open
 * forever (execFile would then never resolve). Hard timeout so startup never hangs silently.
 */
const defaultRun: RunFn = (bin, args) =>
  new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d: Buffer) => (out += d.toString()));
    child.stderr.on("data", (d: Buffer) => (out += d.toString()));
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`opentunnel did not answer in 60 s. Output so far:\n${out.slice(0, 500)}`));
    }, 60_000);
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      // Give buffered output a tick to flush, then stop listening (grandchildren may hold the pipes).
      setImmediate(() => {
        child.stdout.destroy();
        child.stderr.destroy();
        code === 0 ? resolve(out) : reject(new Error(`exit code ${code}\n${out.slice(0, 500)}`));
      });
    });
  });

/**
 * Exposes the bridge port through opentunnel and returns its public HTTPS URL.
 * `route add` is idempotent: the same port keeps the same random route name, so the
 * URL Google Chat is configured with survives restarts. The first run creates the
 * tunnel (and its certificate) and installs opentunnel's own login service.
 */
export async function ensureTunnel(port: number, run: RunFn = defaultRun): Promise<string> {
  let out: string;
  try {
    out = await run("opentunnel", ["route", "add", String(port)]);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error("opentunnel is not installed: npm i -g opentunnel (or set TUNNEL=off and GOOGLE_TOKEN_AUDIENCE)");
    }
    throw new Error(`opentunnel failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  const url = out.match(/https:\/\/[a-z0-9.-]+\.opentunnel\.xyz/i)?.[0];
  if (!url) throw new Error(`opentunnel returned no public URL:\n${out.slice(0, 500)}`);
  return url;
}
