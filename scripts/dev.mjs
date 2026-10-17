import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

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
}

function shutdown(code = 0) {
  for (const child of children) child.kill();
  process.exit(code);
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

console.info("");
console.info(`  UI (hot reload):   http://127.0.0.1:${webPort}`);
console.info(`  control plane:     http://127.0.0.1:${adminPort}`);
console.info(`  bridge (Chat):     http://127.0.0.1:${bridgePort}`);
console.info("");

run("backend", "cargo", ["run", "--manifest-path", "rust/Cargo.toml", "--", ...driverArgs]);
run("web", process.execPath, [vite, "--config", "web/vite.config.ts", "--clearScreen", "false"]);
