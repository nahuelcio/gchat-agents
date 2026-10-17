import type { AddressInfo } from "node:net";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAdminServer } from "../src/admin.js";
import { SettingsStore } from "../src/settings.js";
import { SessionStore } from "../src/store.js";
import {
  claudeMcpConfig,
  handleRpc,
  opencodeMcpConfig,
  runTool,
} from "../src/switchboard-mcp.js";

describe("switchboard MCP helpers", () => {
  it("builds claude and opencode MCP configs with thread env", () => {
    const claude = JSON.parse(claudeMcpConfig("/tmp/sb.js", "share/abc", "http://127.0.0.1:8081")) as {
      mcpServers: { switchboard: { args: string[]; env: Record<string, string> } };
    };
    expect(claude.mcpServers.switchboard.args).toEqual(["/tmp/sb.js"]);
    expect(claude.mcpServers.switchboard.env).toEqual({
      SWITCHBOARD_ADMIN_URL: "http://127.0.0.1:8081",
      SWITCHBOARD_THREAD_KEY: "share/abc",
    });

    const oc = JSON.parse(opencodeMcpConfig("/tmp/sb.js", "t1", "http://127.0.0.1:8081/")) as {
      mcp: { switchboard: { command: string[]; env: Record<string, string> } };
    };
    expect(oc.mcp.switchboard.command[1]).toBe("/tmp/sb.js");
    expect(oc.mcp.switchboard.env.SWITCHBOARD_THREAD_KEY).toBe("t1");
  });

  it("lists tools over JSON-RPC", async () => {
    const framed = await handleRpc({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    expect(framed).toContain("link_work_item");
    expect(framed).toContain("clear_work_item");
  });
});

describe("switchboard MCP → admin /api/work-item", () => {
  let base: string;
  let close: () => Promise<void>;
  let sessions: SessionStore;

  beforeEach(async () => {
    const dir = await mkdtemp(join(tmpdir(), "gchat-mcp-"));
    sessions = new SessionStore(join(dir, "sessions.json"));
    const settings = new SettingsStore(join(dir, "config.json"), {
      agentDriver: "opencode",
      models: {},
      agents: {},
      repos: {},
      allowedSpaces: [],
    });
    const server = createAdminServer(settings, { store: sessions });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    close = () => new Promise((r) => server.close(() => r()));
  });
  afterEach(() => close());

  it("link_work_item and clear_work_item update the session store", async () => {
    const env = {
      SWITCHBOARD_ADMIN_URL: base,
      SWITCHBOARD_THREAD_KEY: "share/team-1",
    };
    expect(await runTool("link_work_item", { id: 42424 }, env)).toContain("#42424");
    expect(sessions.get("share/team-1")?.workItemId).toBe(42424);

    const rpc = await handleRpc(
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "clear_work_item", arguments: {} } },
      env,
    );
    expect(rpc).toContain("Cleared");
    expect(sessions.get("share/team-1")?.workItemId).toBeUndefined();
  });

  it("rejects a bad id", async () => {
    await expect(
      runTool("link_work_item", { id: -1 }, { SWITCHBOARD_ADMIN_URL: base, SWITCHBOARD_THREAD_KEY: "t" }),
    ).rejects.toThrow(/positive/);
  });
});
