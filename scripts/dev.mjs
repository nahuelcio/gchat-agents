import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const vite = join(root, "node_modules/vite/bin/vite.js");
const adminPort = process.env.ADMIN_PORT ?? "8081";
const webPort = process.env.DEV_WEB_PORT ?? "5173";
const bridgePort = process.env.PORT ?? "8080";
const driverArgs = process.argv.slice(2);

const env = { ...process.env };
const children = [];

function run(label, cmd, args) {
  const child = spawn(cmd, args, { env, stdio: "inherit", cwd: root });
  child.on("exit", (code, signal) => {
    if (signal || code === 0 || code === null) return;
    console.error(`[dev] ${label} exited with code ${code}`);
    shutdown(code);
  });
  children.push(child);
  return child;
}

function shutdown(code = 0) {
  for (const child of children) child.kill();
  process.exit(code);
}

async function waitForAdmin(backend, ms = 300_000) {
  const url = `http://127.0.0.1:${adminPort}/api/health`;
  const start = Date.now();
  process.stdout.write(`[dev] waiting for control plane on :${adminPort}…`);
  while (Date.now() - start < ms) {
    if (backend.exitCode != null) {
      throw new Error(`backend exited before ready (code ${backend.exitCode})`);
    }
    try {
      const res = await fetch(url);
      if (res.ok) {
        console.info(" ready");
        return;
      }
    } catch {
      // not up yet
    }
    process.stdout.write(".");
    await sleep(500);
  }
  throw new Error(`control plane did not become ready within ${ms}ms`);
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

console.info("");
console.info(`  UI (hot reload):   http://127.0.0.1:${webPort}`);
console.info(`  control plane:     http://127.0.0.1:${adminPort}`);
console.info(`  bridge (Chat):     http://127.0.0.1:${bridgePort}`);
console.info("");

const backend = run("backend", "cargo", ["run", "--manifest-path", "rust/Cargo.toml", "--", ...driverArgs]);

try {
  await waitForAdmin(backend);
} catch (err) {
  console.error(`\n[dev] ${err.message}`);
  shutdown(1);
}

run("web", process.execPath, [vite, "--config", "web/vite.config.ts", "--clearScreen", "false"]);
