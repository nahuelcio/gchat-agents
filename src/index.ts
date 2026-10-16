import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.js";
import { HttpChatClient } from "./chat-client.js";
import { createAdminServer } from "./admin.js";
import { detectAdo } from "./integrations.js";
import { detectAgents, opencodeModels } from "./agents.js";
import type { HandlerDeps } from "./handler.js";
import { TurnQueue } from "./queue.js";
import { SessionStore } from "./store.js";
import { createHttpServer } from "./server.js";
import { SettingsStore } from "./settings.js";
import { ConfiguredDriver } from "./driver/configured.js";
import { GoogleTokenVerifier } from "./verify.js";
import { Workspaces } from "./workspace.js";

const config = loadConfig();

mkdirSync(config.dataDir, { recursive: true });

// Env is the seed; whatever the control plane saved in config.json wins.
const settings = new SettingsStore(join(config.dataDir, "config.json"), {
  agentDriver: config.agentDriver,
  models: { opencode: config.opencodeModel, claude: config.claudeModel },
  repos: config.repos,
  allowedSpaces: config.allowedSpaces,
});

const workspaces = new Workspaces(join(config.dataDir, "worktrees"), settings.get().repos);

const deps: HandlerDeps = {
  verifier: new GoogleTokenVerifier(config.tokenAudience),
  driver: new ConfiguredDriver(settings, {
    opencodeBin: config.opencodeBin,
    claudeBin: config.claudeBin,
    timeoutMs: config.turnTimeoutMs,
  }),
  chat: new HttpChatClient(config.serviceAccountJson),
  store: new SessionStore(join(config.dataDir, "sessions.json")),
  queue: new TurnQueue(),
  config: { allowedSpaces: settings.get().allowedSpaces, workdir: config.workdir },
  workspaces,
};

settings.onChange((s) => {
  deps.config.allowedSpaces = s.allowedSpaces;
  workspaces.setRepos(s.repos);
  console.info(`[settings] updated: driver=${s.agentDriver}, repos=${Object.keys(s.repos).join(", ") || "none"}`);
});

const server = createHttpServer(deps);
server.listen(config.port, () => {
  console.info(`gchat-agents listening on :${config.port} (workdir: ${config.workdir})`);
  console.info(`allowlist: ${deps.config.allowedSpaces.join(", ") || "EMPTY — set spaces in the control plane"}`);
});

// Loopback only: the control plane holds API keys. Never expose it through the tunnel.
const admin = createAdminServer(settings, {
  store: deps.store,
  workspaces,
  reposDir: join(config.dataDir, "repos"),
  detectAdo: () => detectAdo(homedir(), process.env),
  detectAgents: () => detectAgents({ opencode: config.opencodeBin, claude: config.claudeBin }),
  opencodeModels: () => opencodeModels(config.opencodeBin),
  // dist/src/index.js -> <repo>/web/dist
  webDir: fileURLToPath(new URL("../../web/dist", import.meta.url)),
});
admin.listen(config.adminPort, "127.0.0.1", () => {
  console.info(`control plane: http://127.0.0.1:${config.adminPort}`);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    console.info(`received ${signal}, closing`);
    workspaces.killAll();
    admin.close();
    server.close(() => process.exit(0));
  });
}
