import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { SettingsStore, type Settings } from "../src/settings.js";

const defaults: Settings = {
  agentDriver: "pi",
  models: {},
  repos: {},
  allowedSpaces: ["spaces/ENV"],
  contextFooter: "every5",
  autoCompactAt: 85,
  personas: [],
};

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
      models: { pi: "anthropic/claude-sonnet-5-5" },
      repos: { web: { path: dir, up: "npm start" } },
      allowedSpaces: ["spaces/AAA"],
      contextFooter: "every",
    });
    expect(new SettingsStore(file, defaults).get()).toEqual({
      contextFooter: "every",
      autoCompactAt: 85,
      personas: [],
      agentDriver: "pi",
      models: { pi: "anthropic/claude-sonnet-5-5" },
      repos: { web: { path: dir, up: "npm start" } },
      allowedSpaces: ["spaces/AAA"],
    });
  });

  it("always keeps agentDriver as pi even when a legacy value is patched", async () => {
    const file = join(dir, "config.json");
    await new SettingsStore(file, defaults).update({ agentDriver: "claude" as never });
    expect(new SettingsStore(file, defaults).get().agentDriver).toBe("pi");
  });

  it("rejects invalid input without changing anything", async () => {
    const store = new SettingsStore(join(dir, "config.json"), defaults);
    await expect(store.update({ repos: { web: { path: "relative/dir" } } })).rejects.toThrow(/absolute/);
    await expect(store.update({ repos: { web: { path: join(dir, "missing") } } })).rejects.toThrow(/does not exist/);
    await expect(store.update({ repos: { "a b": { path: dir } } })).rejects.toThrow(/repo name/);
    await expect(store.update({ allowedSpaces: ["AAA"] })).rejects.toThrow(/spaces\//);
    await expect(store.update({ contextFooter: "sometimes" as never })).rejects.toThrow(/contextFooter/);
    await expect(store.update({ autoCompactAt: 120 })).rejects.toThrow(/autoCompactAt/);
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
