import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "./config.js";
import { HttpChatClient } from "./chat-client.js";
import { handleEvent, type HandlerDeps } from "./handler.js";
import { TurnQueue } from "./queue.js";
import { SessionStore } from "./store.js";
import { createHttpServer } from "./server.js";
import { ClaudeDriver } from "./driver/claude.js";
import { OpenCodeDriver } from "./driver/opencode.js";
import { GoogleTokenVerifier } from "./verify.js";

const config = loadConfig();

mkdirSync(config.dataDir, { recursive: true });

const driver =
  config.agentDriver === "claude"
    ? new ClaudeDriver({
        bin: config.claudeBin,
        model: config.claudeModel,
        timeoutMs: config.turnTimeoutMs,
      })
    : new OpenCodeDriver({
        bin: config.opencodeBin,
        model: config.opencodeModel,
        timeoutMs: config.turnTimeoutMs,
      });

const deps: HandlerDeps = {
  verifier: new GoogleTokenVerifier(config.tokenAudience),
  driver,
  chat: new HttpChatClient(config.serviceAccountJson),
  store: new SessionStore(join(config.dataDir, "sessions.json")),
  queue: new TurnQueue(),
  config: { allowedSpaces: config.allowedSpaces, workdir: config.workdir },
};

const server = createHttpServer(deps);
server.listen(config.port, () => {
  console.info(`gchat-agents listening on :${config.port} (workdir: ${config.workdir})`);
  console.info(`allowlist: ${deps.config.allowedSpaces.join(", ")}`);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    console.info(`received ${signal}, closing`);
    server.close(() => process.exit(0));
  });
}
