import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.js";
import { GoogleConnection } from "./google.js";
import { createAdminServer } from "./admin.js";
import { detectAdo } from "./integrations.js";
import { detectAgents, opencodeModels } from "./agents.js";
import { processMessage, type HandlerDeps } from "./handler.js";
import { Health } from "./health.js";
import { Scheduler, ScheduleStore, type Job } from "./schedules.js";
import { TurnQueue } from "./queue.js";
import { SessionStore } from "./store.js";
import { createHttpServer } from "./server.js";
import { SettingsStore } from "./settings.js";
import { ConfiguredDriver } from "./driver/configured.js";
import { GoogleTokenVerifier } from "./verify.js";
import { threadSlug, Workspaces } from "./workspace.js";
import { ensureTunnel } from "./tunnel.js";
import { ShareToken } from "./share.js";
import { TranscriptStore } from "./transcripts.js";
import { questionCards } from "./questions.js";

const config = loadConfig();

mkdirSync(config.dataDir, { recursive: true });
mkdirSync(config.workdir, { recursive: true });
// Its own git root: agents walk up to the nearest .git to pick their project (and AGENTS.md);
// without this, a workdir inside this checkout would make the bridge itself the agent's project.
if (!existsSync(join(config.workdir, ".git"))) execFileSync("git", ["init", "-q", config.workdir]);

// Google signs each event for the public endpoint URL; with the tunnel on, that URL is known only now.
let publicUrl: string | undefined;
if (config.tunnel) {
  console.info("connecting tunnel (opentunnel)…");
  publicUrl = await ensureTunnel(config.port);
  console.info(`public endpoint: ${publicUrl}/google/chat  (paste this as the Chat app's HTTP endpoint URL)`);
}
let tokenAudience = config.tokenAudience ?? (publicUrl && `${publicUrl}/google/chat`);
if (!tokenAudience && !config.tunnel) {
  tokenAudience = `http://127.0.0.1:${config.port}/google/chat`;
  console.warn(
    "GOOGLE_TOKEN_AUDIENCE not set with TUNNEL=off; using loopback audience. Google Chat needs the real public URL in GOOGLE_TOKEN_AUDIENCE.",
  );
}
if (!tokenAudience) throw new Error("Set GOOGLE_TOKEN_AUDIENCE, or leave TUNNEL on so it is derived from the tunnel URL");

// Env is the seed; whatever the control plane saved in config.json wins.
const settings = new SettingsStore(join(config.dataDir, "config.json"), {
  agentDriver: config.agentDriver,
  models: { opencode: config.opencodeModel, claude: config.claudeModel },
  repos: config.repos,
  allowedSpaces: config.allowedSpaces,
});

// Env var wins; otherwise the key saved from the control plane (data/google-sa.json).
const google = new GoogleConnection(join(config.dataDir, "google-sa.json"), config.serviceAccountJson);
const health = new Health(join(config.dataDir, "health.json"), process.env);
const schedules = new ScheduleStore(join(config.dataDir, "schedules.json"));
const workspaces = new Workspaces(join(config.dataDir, "worktrees"), settings.get().repos);

const deps: HandlerDeps = {
  verifier: new GoogleTokenVerifier(tokenAudience),
  driver: new ConfiguredDriver(settings, {
    opencodeBin: config.opencodeBin,
    claudeBin: config.claudeBin,
    timeoutMs: config.turnTimeoutMs,
  }),
  chat: google,
  store: new SessionStore(join(config.dataDir, "sessions.json")),
  queue: new TurnQueue(),
  config: { allowedSpaces: settings.get().allowedSpaces, workdir: config.workdir },
  workspaces,
  schedules,
  options: () => {
    const s = settings.get();
    return {
      contextFooter: s.contextFooter,
      autoCompactAt: s.autoCompactAt,
      defaultModel: s.models[s.agentDriver],
      defaultDriver: s.agentDriver,
      defaultModels: s.models,
    };
  },
};

/** One scheduled run = one turn in the job's own thread; results post to its space. */
async function runJob(job: Job): Promise<boolean> {
  const threadKey = `schedule/${job.id}`;
  if (job.repo && !deps.store.get(threadKey)?.worktree) {
    const { worktree, branch } = await workspaces.create(job.repo, threadSlug(`schedule-${job.id}`));
    await deps.store.update(threadKey, job.space, { repo: job.repo, worktree, branch });
  }
  const { ok } = await processMessage(
    {
      threadKey,
      spaceName: job.space,
      text: job.prompt,
      sender: `Schedule "${job.name}"`,
      // Jobs made from the team chat have no Chat space to post to: the run still happens and is recorded.
      reply: async (text, meta) => {
        if (job.space.startsWith("spaces/")) {
          await deps.chat.postMessage(job.space, {
            text,
            thread: { threadKey: `schedule-${job.id}` },
            ...(meta?.questions?.length && { cardsV2: questionCards(meta.questions) }),
          });
        }
      },
      answerQuestions: false,
    },
    deps,
  );
  return ok;
}
const scheduler = new Scheduler(schedules, runJob);
scheduler.start();
// Heartbeat: proves the event loop is alive; a wedged process stops beating.
setInterval(() => health.beat(), 15_000).unref();

settings.onChange((s) => {
  deps.config.allowedSpaces = s.allowedSpaces;
  workspaces.setRepos(s.repos);
  console.info(`[settings] updated: driver=${s.agentDriver}, repos=${Object.keys(s.repos).join(", ") || "none"}`);
});

const shareToken = new ShareToken(join(config.dataDir, "share-token"));
const webDir = fileURLToPath(new URL("../../web/dist", import.meta.url));
const listAgents = () => detectAgents({ opencode: config.opencodeBin, claude: config.claudeBin });
const transcripts = new TranscriptStore(join(config.dataDir, "transcripts"));
const server = createHttpServer(deps, { token: shareToken, webDir, agents: listAgents, transcripts });
server.listen(config.port, () => {
  console.info(`gchat-agents listening on :${config.port} (workdir: ${config.workdir})`);
  console.info(`allowlist: ${deps.config.allowedSpaces.join(", ") || "EMPTY — set spaces in the control plane"}`);
  if (!google.status().configured) {
    console.warn("Google Chat not connected: replies are off. Connect it in the control plane (Settings › Google Chat); the team chat works meanwhile.");
  }
});

// Loopback only: the control plane holds API keys. Never expose it through the tunnel.
const admin = createAdminServer(settings, {
  store: deps.store,
  workspaces,
  reposDir: join(config.dataDir, "repos"),
  detectAdo: () => detectAdo(homedir(), process.env),
  detectAgents: listAgents,
  opencodeModels: () => opencodeModels(config.opencodeBin),
  handler: deps,
  schedules,
  scheduler,
  health,
  publicUrl,
  google,
  webDir,
  shareToken,
  transcripts,
});
admin.listen(config.adminPort, "127.0.0.1", () => {
  console.info(`control plane: http://127.0.0.1:${config.adminPort}`);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    console.info(`received ${signal}, closing`);
    workspaces.killAll();
    scheduler.stop();
    health.markStopped();
    admin.close();
    server.close(() => process.exit(0));
  });
}
