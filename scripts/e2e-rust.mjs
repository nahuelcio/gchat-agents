import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = await mkdtemp(join(tmpdir(), "switchboard-e2e-"));
await mkdir(join(dataDir, "workspace"), { recursive: true });

const bridgePort = 18080 + Math.floor(Math.random() * 1000);
const adminPort = bridgePort + 1;

const env = {
  ...process.env,
  DATA_DIR: dataDir,
  PORT: String(bridgePort),
  ADMIN_PORT: String(adminPort),
  TUNNEL: "off",
  SWITCHBOARD_SKIP_VERIFY: "1",
  AGENT_WORKDIR: join(dataDir, "workspace"),
  GOOGLE_TOKEN_AUDIENCE: `http://127.0.0.1:${bridgePort}/google/chat`,
};

const targetDir = process.env.CARGO_TARGET_DIR || join(root, "rust", "target");
const bin = process.platform === "win32"
  ? join(targetDir, "debug", "switchboard.exe")
  : join(targetDir, "debug", "switchboard");

console.log(`e2e data: ${dataDir}`);
console.log(`ports bridge=${bridgePort} admin=${adminPort}`);
console.log(`starting ${bin}`);

const child = spawn(bin, ["--driver", "echo"], {
  cwd: root,
  env,
  stdio: ["ignore", "pipe", "pipe"],
});

child.stdout.on("data", (b) => process.stdout.write(b));
child.stderr.on("data", (b) => process.stderr.write(b));

async function waitReady(ms = 20000) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (child.exitCode != null) {
      throw new Error(`process exited early with code ${child.exitCode}`);
    }
    try {
      const res = await fetch(`http://127.0.0.1:${bridgePort}/healthz`);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await sleep(200);
  }
  throw new Error("server did not become ready");
}

function fail(msg) {
  console.error(`FAIL: ${msg}`);
  try {
    child.kill();
  } catch {
    // ignore
  }
  process.exit(1);
}

try {
  await waitReady();

  const healthz = await fetch(`http://127.0.0.1:${bridgePort}/healthz`);
  if (!healthz.ok) fail(`/healthz status ${healthz.status}`);
  const hz = await healthz.json();
  if (hz.ok !== true) fail(`/healthz body ${JSON.stringify(hz)}`);
  console.log("ok /healthz");

  const health = await fetch(`http://127.0.0.1:${adminPort}/api/health`, {
    headers: { host: `127.0.0.1:${adminPort}` },
  });
  if (!health.ok) fail(`/api/health status ${health.status}`);
  const hs = await health.json();
  if (typeof hs.starts !== "number") fail(`/api/health missing starts`);
  console.log("ok /api/health");

  const settings = await fetch(`http://127.0.0.1:${adminPort}/api/settings`, {
    headers: { host: `127.0.0.1:${adminPort}` },
  });
  if (!settings.ok) fail(`/api/settings status ${settings.status}`);
  const st = await settings.json();
  if (!st.agentDriver) fail(`/api/settings missing agentDriver`);
  console.log("ok /api/settings");

  const agents = await fetch(`http://127.0.0.1:${adminPort}/api/agents`, {
    headers: { host: `127.0.0.1:${adminPort}` },
  });
  if (!agents.ok) fail(`/api/agents status ${agents.status}`);
  const ag = await agents.json();
  if (!Array.isArray(ag) || ag.length < 1) fail(`/api/agents unexpected ${JSON.stringify(ag)}`);
  console.log("ok /api/agents");

  const schedules = await fetch(`http://127.0.0.1:${adminPort}/api/schedules`, {
    headers: { host: `127.0.0.1:${adminPort}` },
  });
  if (!schedules.ok) fail(`/api/schedules status ${schedules.status}`);
  console.log("ok /api/schedules");

  const threads = await fetch(`http://127.0.0.1:${adminPort}/api/threads`, {
    headers: { host: `127.0.0.1:${adminPort}` },
  });
  if (!threads.ok) fail(`/api/threads status ${threads.status}`);
  console.log("ok /api/threads");

  const chat = await fetch(`http://127.0.0.1:${bridgePort}/google/chat`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer test" },
    body: JSON.stringify({
      type: "MESSAGE",
      space: { name: "spaces/nope" },
      message: { text: "hi", thread: { name: "spaces/nope/threads/t" } },
    }),
  });
  if (!chat.ok) fail(`/google/chat status ${chat.status}`);
  const cb = await chat.json();
  if (cb.ok !== true) fail(`/google/chat body ${JSON.stringify(cb)}`);
  console.log("ok /google/chat");

  const ado = await fetch(`http://127.0.0.1:${adminPort}/api/ado/status`, {
    headers: { host: `127.0.0.1:${adminPort}` },
  });
  if (!ado.ok) fail(`/api/ado/status status ${ado.status}`);
  const adoBody = await ado.json();
  if (typeof adoBody.connected !== "boolean") fail(`/api/ado/status missing connected`);
  console.log("ok /api/ado/status");

  const putSpaces = await fetch(`http://127.0.0.1:${adminPort}/api/settings`, {
    method: "PUT",
    headers: { host: `127.0.0.1:${adminPort}`, "content-type": "application/json" },
    body: JSON.stringify({
      allowedSpaces: ["spaces/e2e"],
      personas: [{ name: "qa", prompt: "You are QA" }],
    }),
  });
  if (!putSpaces.ok) fail(`/api/settings put status ${putSpaces.status}`);
  const st2 = await putSpaces.json();
  if (!Array.isArray(st2.personas) || st2.personas.length < 1) fail(`personas not saved`);
  console.log("ok personas settings");

  const chat2 = await fetch(`http://127.0.0.1:${bridgePort}/google/chat`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer test" },
    body: JSON.stringify({
      type: "MESSAGE",
      space: { name: "spaces/e2e" },
      message: {
        text: "hello e2e",
        thread: { name: "spaces/e2e/threads/t1" },
        sender: { displayName: "Tester" },
      },
    }),
  });
  if (!chat2.ok) fail(`/google/chat allowed status ${chat2.status}`);
  const cb2 = await chat2.json();
  if (cb2.ok !== true || cb2.dropped) fail(`/google/chat allowed body ${JSON.stringify(cb2)}`);
  console.log("ok /google/chat allowlisted");

  const mcp = spawn(bin, ["mcp"], {
    cwd: root,
    env: { ...env, SWITCHBOARD_ADMIN_URL: `http://127.0.0.1:${adminPort}` },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const mcpOut = await new Promise((resolve, reject) => {
    let buf = "";
    const timer = setTimeout(() => {
      mcp.kill();
      reject(new Error("mcp tools/list timeout"));
    }, 5000);
    mcp.stdout.on("data", (d) => {
      buf += d.toString();
      if (buf.includes("invite_agent")) {
        clearTimeout(timer);
        mcp.kill();
        resolve(buf);
      }
    });
    mcp.stderr.on("data", () => {});
    mcp.stdin.write(
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) + "\n",
    );
  });
  if (!mcpOut.includes("list_repos")) fail("mcp tools/list missing list_repos");
  console.log("ok switchboard mcp tools/list");

  const members = await fetch(`http://127.0.0.1:${adminPort}/api/team/members`, {
    method: "POST",
    headers: { host: `127.0.0.1:${adminPort}`, "content-type": "application/json" },
    body: JSON.stringify({
      thread: "e2e-room-1",
      op: "add",
      member: { kind: "agent", persona: "qa" },
    }),
  });
  if (!members.ok) fail(`/api/team/members status ${members.status}`);
  const mb = await members.json();
  if (!Array.isArray(mb.members) || !mb.members.some((m) => m.kind === "agent" && m.persona === "qa")) {
    fail(`/api/team/members body ${JSON.stringify(mb)}`);
  }
  console.log("ok /api/team/members");

  console.log("e2e PASS");
  child.kill();
  process.exit(0);
} catch (err) {
  fail(err instanceof Error ? err.message : String(err));
}
