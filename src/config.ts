import { homedir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import type { RepoConfig } from "./workspace.js";

export interface Config {
  port: number;
  tokenAudience?: string;
  tunnel: boolean;
  serviceAccountJson?: string;
  allowedSpaces: string[];
  agentDriver: AgentDriverKind;
  workdir: string;
  turnTimeoutMs: number;
  dataDir: string;
  repos: Record<string, RepoConfig>;
  adminPort: number;
}

export type AgentDriverKind = "pi";

export function driverKind(value: string): AgentDriverKind {
  if (value === "pi" || value === "opencode" || value === "claude") return "pi";
  throw new Error(`AGENT_DRIVER must be "pi" (got "${value}")`);
}

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
  return {
    port: Number(env["PORT"] ?? "") || 8080,
    tokenAudience: env["GOOGLE_TOKEN_AUDIENCE"]?.trim() || undefined,
    tunnel: (env["TUNNEL"]?.trim() || "on") !== "off",
    serviceAccountJson: env["GOOGLE_SERVICE_ACCOUNT_JSON"]?.trim() || undefined,
    allowedSpaces,
    agentDriver: driverKind(env["AGENT_DRIVER"]?.trim() || "pi"),
    workdir: env["AGENT_WORKDIR"]?.trim() || join(env["XDG_DATA_HOME"]?.trim() || join(homedir(), ".local", "share"), "switchboard", "workspace"),
    turnTimeoutMs,
    dataDir: env["DATA_DIR"]?.trim() || "./data",
    adminPort: Number(env["ADMIN_PORT"] ?? "") || 8081,
    repos: loadRepos(env["AGENT_REPOS_FILE"]?.trim() || undefined),
  };
}
