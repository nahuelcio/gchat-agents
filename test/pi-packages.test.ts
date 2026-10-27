import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { dependencyAdded, isGitSpec, mcpConfigFromSettings, packageMatches, packageName, pendingDefaults, PiPackages } from "../harness/pi-packages.ts";

const HOSTS = ["typebox", "@earendil-works/pi-ai"];

test("git specs are the github forms the installer accepts", () => {
  expect(isGitSpec("https://github.com/earendil-works/pi-claude-code")).toBe(true);
  expect(isGitSpec("https://github.com/earendil-works/pi-claude-code/")).toBe(true);
  expect(isGitSpec("github:earendil-works/pi-claude-code#main")).toBe(true);
  expect(isGitSpec("git+https://github.com/earendil-works/pi-claude-code.git")).toBe(true);
  expect(isGitSpec("pi-web-search")).toBe(false);
  expect(isGitSpec("https://github.com/earendil-works/pi-claude-code && calc")).toBe(false);
  expect(packageName("@earendil-works/pi-claude-code@1.2.3")).toBe("@earendil-works/pi-claude-code");
});

test("a git install name is the new dependency, not a host package", () => {
  const spec = "https://github.com/earendil-works/pi-claude-code";
  const deps = {
    typebox: "^1.0.0",
    "@earendil-works/pi-ai": "1.4.0",
    "@earendil-works/pi-claude-code": "github:earendil-works/pi-claude-code",
  };
  expect(dependencyAdded(["typebox"], deps, spec, HOSTS)).toBe("@earendil-works/pi-claude-code");
  expect(dependencyAdded(Object.keys(deps), deps, spec, HOSTS)).toBe("@earendil-works/pi-claude-code");
});

test("a loaded extension's provider, commands and UI hooks are kept", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-packages-"));
  const packages = join(dir, "pi-packages");
  const root = join(packages, "node_modules", "fake-provider");
  mkdirSync(root, { recursive: true });
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ name: "fake-provider", type: "module", pi: { extensions: ["./index.js"] } }),
  );
  writeFileSync(
    join(root, "index.js"),
    `export default function (pi) {
      pi.registerProvider({ id: "claude-code", name: "Claude Code", getModels: () => [{ id: "sonnet" }] });
      pi.registerCommand("claude-code-status", { description: "status", handler: () => "ok" });
      pi.on("agent_end", () => {});
    }\n`,
  );
  writeFileSync(join(packages, "packages.json"), JSON.stringify({ packages: [{ name: "fake-provider", spec: "fake-provider" }] }));

  const loaded = await new PiPackages(dir).loadAll();
  expect(loaded).toHaveLength(1);
  expect(loaded[0]?.error).toBeUndefined();
  expect(loaded[0]?.providers.map((p) => p.id)).toEqual(["claude-code"]);
  expect(loaded[0]?.providers[0]?.getModels?.().map((m) => m.id)).toEqual(["sonnet"]);
  expect(loaded[0]?.commands.map((c) => c.name)).toEqual(["claude-code-status"]);
  expect(loaded[0]?.hooks.map((h) => h.event)).toEqual(["agent_end"]);
  expect(loaded[0]?.ignored).not.toContain("registerCommand");
});

test("a removed default stays removed and settings mcp servers become the adapter config", () => {
  expect(packageMatches({ name: "@earendil-works/pi-claude-code", spec: "https://github.com/earendil-works/pi-claude-code" }, { name: "@earendil-works/pi-claude-code", spec: "https://github.com/earendil-works/pi-claude-code/" })).toBe(true);
  expect(pendingDefaults([], [])).toHaveLength(2);
  expect(pendingDefaults([{ name: "pi-mcp-adapter", spec: "pi-mcp-adapter" }], [])).toEqual([
    { name: "@earendil-works/pi-claude-code", spec: "https://github.com/earendil-works/pi-claude-code" },
  ]);
  expect(pendingDefaults([], ["pi-mcp-adapter", "@earendil-works/pi-claude-code"])).toEqual([]);
  expect(mcpConfigFromSettings(JSON.stringify({ mcpServers: [{ name: "engram", command: "engram", args: ["mcp"], env: { A: "1" } }, { name: "skip" }] }))).toEqual({
    mcpServers: { engram: { command: "engram", args: ["mcp"], env: { A: "1" } } },
    settings: { hostConfigDiscovery: "off" },
  });
});

test("the adapter gets switchboard servers and does not see Pi's built-in MCP", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-packages-"));
  const packages = join(dir, "pi-packages");
  const root = join(packages, "node_modules", "pi-mcp-adapter");
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "pi-mcp-adapter", type: "module", pi: { extensions: ["./index.js"] } }));
  writeFileSync(
    join(root, "index.js"),
    `export function createMcpAdapter(opts) {
      return (pi) => {
        pi.registerTool({ name: "mcp", description: Object.keys(opts.config.mcpServers).join(","), parameters: {} });
        pi.registerTool({ name: typeof pi.registerMcpServer === "function" ? "builtin" : "hosted", description: "probe", parameters: {} });
      };
    }
    export default function (pi) {
      pi.registerTool({ name: "from-default", description: "no", parameters: {} });
    }\n`,
  );
  writeFileSync(join(packages, "packages.json"), JSON.stringify({ packages: [{ name: "pi-mcp-adapter", spec: "pi-mcp-adapter" }] }));
  const pi = new PiPackages(dir);
  pi.mcpConfig = { mcpServers: { engram: { command: "engram", args: ["mcp"] } }, settings: { hostConfigDiscovery: "off" } };
  const loaded = await pi.loadAll();
  expect(loaded[0]?.error).toBeUndefined();
  expect(loaded[0]?.tools.map((t) => t.name)).toEqual(["mcp", "hosted"]);
  expect(loaded[0]?.tools[0]?.description).toBe("engram");
});
