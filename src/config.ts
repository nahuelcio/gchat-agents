export interface Config {
  port: number;
  tokenAudience: string;
  serviceAccountJson: string;
  allowedSpaces: string[];
  agentDriver: AgentDriverKind;
  workdir: string;
  opencodeBin: string;
  opencodeModel?: string;
  claudeBin: string;
  claudeModel?: string;
  turnTimeoutMs: number;
  dataDir: string;
}

export type AgentDriverKind = "opencode" | "claude";

function driverKind(value: string): AgentDriverKind {
  if (value === "opencode" || value === "claude") return value;
  throw new Error(`AGENT_DRIVER must be "opencode" or "claude" (got "${value}")`);
}

function required(env: Record<string, string | undefined>, key: string): string {
  const value = env[key]?.trim();
  if (!value) throw new Error(`Missing required env var ${key} (see .env.example)`);
  return value;
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const allowedSpaces = (env["CHAT_ALLOWED_SPACES"] ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (allowedSpaces.length === 0) {
    throw new Error("CHAT_ALLOWED_SPACES must list at least one space (e.g. spaces/AAA)");
  }
  const turnTimeoutMs = Number(env["AGENT_TURN_TIMEOUT_MS"] ?? "") || 600_000;
  const opencodeModel = env["OPENCODE_MODEL"]?.trim() || undefined;
  const claudeModel = env["CLAUDE_MODEL"]?.trim() || undefined;
  return {
    port: Number(env["PORT"] ?? "") || 8080,
    tokenAudience: required(env, "GOOGLE_TOKEN_AUDIENCE"),
    serviceAccountJson: required(env, "GOOGLE_SERVICE_ACCOUNT_JSON"),
    allowedSpaces,
    agentDriver: driverKind(env["AGENT_DRIVER"]?.trim() || "opencode"),
    workdir: env["AGENT_WORKDIR"]?.trim() || process.cwd(),
    opencodeBin: env["OPENCODE_BIN"]?.trim() || "opencode",
    opencodeModel,
    claudeBin: env["CLAUDE_BIN"]?.trim() || "claude",
    claudeModel,
    turnTimeoutMs,
    dataDir: env["DATA_DIR"]?.trim() || "./data",
  };
}
