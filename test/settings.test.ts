import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { SettingsStore, type Settings } from "../src/settings.js";

const defaults: Settings = { agentDriver: "opencode", models: {}, repos: {}, allowedSpaces: ["spaces/ENV"] };

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "gchat-settings-"));
});

describe("SettingsStore", () => {
  it("starts from the env defaults when no file exists", () => {
    expect(new SettingsStore(join(dir, "config.json"), defaults).get()).toEqual(defaults);
  });

  it("persists updates and reloads them, file values winning over env defaults", async () => {
    const file = join(dir, "config.json");
    await new SettingsStore(file, defaults).update({
      agentDriver: "claude",
      models: { claude: "claude-opus-5-5" },
      repos: { web: { path: dir, up: "npm start" } },
      allowedSpaces: ["spaces/AAA"],
    });
    expect(new SettingsStore(file, defaults).get()).toEqual({
      agentDriver: "claude",
      models: { claude: "claude-opus-5-5" },
      repos: { web: { path: dir, up: "npm start" } },
      allowedSpaces: ["spaces/AAA"],
    });
  });

  it("rejects invalid input without changing anything", async () => {
    const store = new SettingsStore(join(dir, "config.json"), defaults);
    await expect(store.update({ agentDriver: "gemini" as never })).rejects.toThrow(/agentDriver/);
    await expect(store.update({ repos: { web: { path: "relative/dir" } } })).rejects.toThrow(/absolute/);
    await expect(store.update({ repos: { web: { path: join(dir, "missing") } } })).rejects.toThrow(/does not exist/);
    await expect(store.update({ repos: { "a b": { path: dir } } })).rejects.toThrow(/repo name/);
    await expect(store.update({ allowedSpaces: ["AAA"] })).rejects.toThrow(/spaces\//);
    expect(store.get()).toEqual(defaults);
  });

  it("notifies listeners after a successful update", async () => {
    const store = new SettingsStore(join(dir, "config.json"), defaults);
    const seen: Settings[] = [];
    store.onChange((s) => seen.push(s));
    await store.update({ allowedSpaces: ["spaces/NEW"] });
    expect(seen[0]?.allowedSpaces).toEqual(["spaces/NEW"]);
  });
});
