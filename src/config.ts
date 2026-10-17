import { homedir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import type { RepoConfig } from "./workspace.js";

export interface Config {
  port: number;
  /** Omitted = derived from the tunnel URL at startup. */
  tokenAudience?: string;
  /** Expose the bridge through opentunnel on startup (default on). */
  tunnel: boolean;
  /** Omitted = no Chat replies (team chat and the control plane still work). */
  serviceAccountJson?: string;
  allowedSpaces: string[];
  agentDriver: AgentDriverKind;
  workdir: string;
  opencodeBin: string;
  opencodeModel?: string;
  claudeBin: string;
  claudeModel?: string;
  turnTimeoutMs: number;
  dataDir: string;
  repos: Record<string, RepoConfig>;
  adminPort: number;
}

export type AgentDriverKind = "opencode" | "claude";

function driverKind(value: string): AgentDriverKind {
  if (value === "opencode" || value === "claude") return value;
  throw new Error(`AGENT_DRIVER must be "opencode" or "claude" (got "${value}")`);
}

/** AGENT_REPOS_FILE: JSON {"name": {"path": "/abs/clone", "up": "npm run dev -- --port {port}"}}. */
export function loadRepos(file: string | undefined): Record<string, RepoConfig> {
  if (!file) return {};
  const parsed = JSON.parse(readFileSync(file, "utf8")) as Record<string, RepoConfig>;
  for (const [name, repo] of Object.entries(parsed)) {
    if (!repo || typeof repo.path !== "string") throw new Error(`AGENT_REPOS_FILE: repo "${name}" needs a "path"`);
  }
  return parsed;
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const allowedSpaces = (env["CHAT_ALLOWED_SPACES"] ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const turnTimeoutMs = Number(env["AGENT_TURN_TIMEOUT_MS"] ?? "") || 600_000;
  const opencodeModel = env["OPENCODE_MODEL"]?.trim() || undefined;
  const claudeModel = env["CLAUDE_MODEL"]?.trim() || undefined;
  return {
    port: Number(env["PORT"] ?? "") || 8080,
    tokenAudience: env["GOOGLE_TOKEN_AUDIENCE"]?.trim() || undefined,
    tunnel: (env["TUNNEL"]?.trim() || "on") !== "off",
    serviceAccountJson: env["GOOGLE_SERVICE_ACCOUNT_JSON"]?.trim() || undefined,
    allowedSpaces,
    agentDriver: driverKind(env["AGENT_DRIVER"]?.trim() || "opencode"),
    // Outside this checkout: agents must neither edit the bridge nor take it as their project.
    workdir: env["AGENT_WORKDIR"]?.trim() || join(env["XDG_DATA_HOME"]?.trim() || join(homedir(), ".local", "share"), "switchboard", "workspace"),
    opencodeBin: env["OPENCODE_BIN"]?.trim() || "opencode",
    opencodeModel,
    claudeBin: env["CLAUDE_BIN"]?.trim() || "claude",
    claudeModel,
    turnTimeoutMs,
    dataDir: env["DATA_DIR"]?.trim() || "./data",
    adminPort: Number(env["ADMIN_PORT"] ?? "") || 8081,
    repos: loadRepos(env["AGENT_REPOS_FILE"]?.trim() || undefined),
  };
}
