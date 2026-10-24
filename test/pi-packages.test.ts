import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { dependencyAdded, isGitSpec, packageName, PiPackages } from "../harness/pi-packages.ts";

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

test("a loaded extension's provider is kept and its commands are ignored", async () => {
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
      pi.registerCommand("claude-code-status", {});
    }\n`,
  );
  writeFileSync(join(packages, "packages.json"), JSON.stringify({ packages: [{ name: "fake-provider", spec: "fake-provider" }] }));

  const loaded = await new PiPackages(dir).loadAll();
  expect(loaded).toHaveLength(1);
  expect(loaded[0]?.error).toBeUndefined();
  expect(loaded[0]?.providers.map((p) => p.id)).toEqual(["claude-code"]);
  expect(loaded[0]?.providers[0]?.getModels?.().map((m) => m.id)).toEqual(["sonnet"]);
  expect(loaded[0]?.ignored).toContain("registerCommand");
});
