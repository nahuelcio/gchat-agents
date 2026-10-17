import { execFileSync, spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const node = process.execPath;
const tsc = join(root, "node_modules/typescript/bin/tsc");
const vite = join(root, "node_modules/vite/bin/vite.js");

const adminPort = process.env.ADMIN_PORT ?? "8081";
const webPort = process.env.DEV_WEB_PORT ?? "5173";
const bridgePort = process.env.PORT ?? "8080";

console.info("building backend once…");
execFileSync(node, [tsc, "-p", "tsconfig.json"], { stdio: "inherit", cwd: root });

// Respect .env (TUNNEL defaults to on, same as `npm start`). Only set a loopback audience when
// you explicitly run with TUNNEL=off and no GOOGLE_TOKEN_AUDIENCE — enough for team chat locally.
const env = { ...process.env };
if (env.TUNNEL === "off" && !env.GOOGLE_TOKEN_AUDIENCE?.trim()) {
  env.GOOGLE_TOKEN_AUDIENCE = `http://127.0.0.1:${bridgePort}/google/chat`;
}

const children = [];

function run(label, args, opts = {}) {
  const child = spawn(node, args, {
    env,
    stdio: "inherit",
    cwd: root,
    ...opts,
  });
  child.on("exit", (code, signal) => {
    if (signal) return;
    if (code !== 0 && code !== null) {
      console.error(`[dev] ${label} exited with code ${code}`);
      shutdown(code ?? 1);
    }
  });
  children.push(child);
}

function shutdown(code = 0) {
  for (const child of children) {
    try {
      child.kill();
    } catch {
      // already gone
    }
  }
  process.exit(code);
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

console.info("");
console.info(`  UI (hot reload):  http://127.0.0.1:${webPort}`);
console.info(`  control plane API:  http://127.0.0.1:${adminPort}/api/…`);
console.info(`  bridge (Chat):      http://127.0.0.1:${bridgePort}`);
console.info("  TUNNEL follows .env (default on). TUNNEL=off without audience uses a loopback URL for Chat verify.");
console.info("");

run("tsc", [tsc, "-p", "tsconfig.json", "--watch", "--preserveWatchOutput"]);
run("bridge", ["--env-file-if-exists=.env", "--watch", "dist/src/index.js"]);
run("web", [vite, "--config", "web/vite.config.ts", "--clearScreen", "false"]);
