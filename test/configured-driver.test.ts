import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ConfiguredDriver } from "../src/driver/configured.js";
import { SettingsStore } from "../src/settings.js";

describe("ConfiguredDriver", () => {
  it("uses the current driver and model on every turn, live", async () => {
    const dir = await mkdtemp(join(tmpdir(), "gchat-cfg-"));
    // Fake claude: echoes its --model arg as the reply.
    const fake = join(dir, "fake-claude");
    await writeFile(
      fake,
      `#!/bin/sh\nwhile [ "$1" != "--model" ] && [ $# -gt 0 ]; do shift; done\n` +
        `printf '{"type":"result","result":"%s","session_id":"x","is_error":false}' "$2"\n`,
    );
    await chmod(fake, 0o755);
    const settings = new SettingsStore(join(dir, "config.json"), {
      agentDriver: "claude",
      models: { claude: "m1" },
      repos: {},
      allowedSpaces: [],
    });
    const driver = new ConfiguredDriver(settings, { opencodeBin: "opencode", claudeBin: fake, timeoutMs: 5000 });
    const input = { threadKey: "t", text: "hi", workdir: dir };

    expect((await driver.runTurn(input)).reply).toBe("m1");
    await settings.update({ models: { claude: "m2" } });
    expect((await driver.runTurn(input)).reply).toBe("m2");
  });
});
