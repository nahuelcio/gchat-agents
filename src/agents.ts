import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolveBin } from "./resolve-bin.js";

const exec = promisify(execFile);

/** Runs a CLI and returns stdout; rejects when the binary is missing or fails. */
export type RunFn = (bin: string, args: string[], timeoutMs: number) => Promise<string>;

const defaultRun: RunFn = async (bin, args, timeoutMs) =>
  (await exec(resolveBin(bin), args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 })).stdout;

export interface DetectedAgent {
  id: string;
  name: string;
  installed: boolean;
  version?: string;
  /** This bridge has a driver for it. */
  supported: boolean;
  /** Installed and authenticated/configured enough to answer a turn. */
  ready?: boolean;
  detail?: string;
}

// Agents the bridge can drive, plus others worth showing so the team knows a driver is one adapter away.
const KNOWN = [
  { id: "opencode", name: "OpenCode", supported: true },
  { id: "claude", name: "Claude Code", supported: true },
  { id: "codex", name: "Codex CLI", supported: false },
  { id: "gemini", name: "Gemini CLI", supported: false },
  { id: "pi", name: "Pi", supported: false },
] as const;

const MODEL_LINE = /^[a-z0-9][\w.-]*\/\S+$/i;

export async function opencodeModels(bin: string, run: RunFn = defaultRun): Promise<string[]> {
  const out = await run(bin, ["models"], 60_000);
  return out
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => MODEL_LINE.test(l));
}

async function readiness(id: string, bin: string, run: RunFn): Promise<Pick<DetectedAgent, "ready" | "detail">> {
  try {
    if (id === "opencode") {
      const models = await opencodeModels(bin, run);
      const viaTokenbank = models.filter((m) => m.startsWith("opencode-admin/")).length;
      if (models.length === 0) return { ready: false, detail: "no models configured — run `opencode auth login`" };
      return { ready: true, detail: `${models.length} models${viaTokenbank ? ` · ${viaTokenbank} via TokenBank` : ""}` };
    }
    if (id === "claude") {
      const status = JSON.parse(await run(bin, ["auth", "status"], 15_000)) as { loggedIn?: boolean; authMethod?: string };
      return status.loggedIn
        ? { ready: true, detail: `logged in${status.authMethod ? ` (${status.authMethod})` : ""}` }
        : { ready: false, detail: "not logged in — run `claude` once to sign in" };
    }
  } catch (err) {
    return { ready: false, detail: `check failed: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}` };
  }
  return {};
}

/**
 * What coding agents are installed on this machine, and which are ready.
 * `bins` maps the supported agents to the binaries the bridge is configured to call.
 */
export async function detectAgents(bins: { opencode: string; claude: string }, run: RunFn = defaultRun): Promise<DetectedAgent[]> {
  return Promise.all(
    KNOWN.map(async ({ id, name, supported }) => {
      const bin = id === "opencode" ? bins.opencode : id === "claude" ? bins.claude : id;
      let version: string | undefined;
      try {
        const out = await run(bin, ["--version"], 10_000);
        version = out.match(/\d+\.\d+\.\d+/)?.[0] ?? (out.trim() || "unknown");
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return { id, name, installed: false, supported };
        version = "unknown"; // present but --version failed
      }
      const agent: DetectedAgent = { id, name, installed: true, version, supported };
      return supported ? { ...agent, ...(await readiness(id, bin, run)) } : agent;
    }),
  );
}
