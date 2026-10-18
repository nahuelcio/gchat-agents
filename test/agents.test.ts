import { describe, expect, it } from "vitest";
import { detectAgents, piModels } from "../src/agents.js";
import { runTool } from "../src/switchboard-mcp.js";

describe("detectAgents", () => {
  it("lists only Pi", async () => {
    const agents = await detectAgents(true, true);
    expect(agents).toHaveLength(1);
    expect(agents[0]).toMatchObject({
      id: "pi",
      name: "Pi (durable)",
      installed: true,
      supported: true,
      ready: true,
      detail: "harness running",
    });
  });

  it("reports harness missing or stopped", async () => {
    expect((await detectAgents(false, false))[0]?.detail).toBe("harness/server.ts not found");
    expect((await detectAgents(true, false))[0]).toMatchObject({ ready: false, detail: "harness starting or stopped" });
  });
});

describe("piModels", () => {
  it("returns an empty list (models come from provider/model + API keys)", async () => {
    expect(await piModels()).toEqual([]);
  });
});

describe("switchboard tools with a thread argument", () => {
  it("uses the thread passed by the agent when the server has none in its env", async () => {
    const seen: string[] = [];
    const fetchFn = (async (_url: string, init?: { body?: string }) => {
      seen.push(JSON.parse(init?.body ?? "{}").threadKey);
      return new Response(JSON.stringify({ members: [] }), { status: 200 });
    }) as unknown as typeof fetch;
    await runTool("invite_agent", { name: "qa", thread: "share/r9" }, { SWITCHBOARD_ADMIN_URL: "http://x" }, fetchFn);
    expect(seen).toEqual(["share/r9"]);
  });
});
