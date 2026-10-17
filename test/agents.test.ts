import { describe, expect, it } from "vitest";
import { claudeModels, detectAgents, ensureOpencodeMcp, opencodeAgents, opencodeModels, type RunFn } from "../src/agents.js";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runTool } from "../src/switchboard-mcp.js";

/** Fake CLI runner: key "bin args..." -> stdout; missing bins throw ENOENT like execFile. */
function fakeRun(outputs: Record<string, string | Error>): RunFn {
  return async (bin, args) => {
    const key = [bin, ...args].join(" ");
    const out = outputs[key];
    if (out instanceof Error) throw out;
    if (out === undefined) throw Object.assign(new Error(`spawn ${bin} ENOENT`), { code: "ENOENT" });
    return out;
  };
}

describe("detectAgents", () => {
  it("reports installed agents, their version and whether they are ready", async () => {
    const run = fakeRun({
      "opencode --version": "opencode v2.0.31\n",
      "opencode models": "opencode-admin/glm-5.3\nopencode-admin/deepseek-v4\nopenai/gpt-5.5\n",
      "claude --version": "2.1.301 (Claude Code)\n",
      "claude auth status": JSON.stringify({ loggedIn: true, authMethod: "claude.ai" }),
      "codex --version": "codex-cli 0.159.2\n",
    });
    const agents = await detectAgents({ opencode: "opencode", claude: "claude" }, run);
    const byId = Object.fromEntries(agents.map((a) => [a.id, a]));

    expect(byId.opencode).toMatchObject({ installed: true, version: "2.0.31", supported: true, ready: true });
    expect(byId.opencode?.detail).toBe("3 models · 2 via TokenBank");
    expect(byId.claude).toMatchObject({ installed: true, version: "2.1.301", supported: true, ready: true, detail: "logged in (claude.ai)" });
    expect(byId.codex).toMatchObject({ installed: true, version: "0.159.2", supported: false });
    expect(byId.gemini).toMatchObject({ installed: false, supported: false });
  });

  it("marks an installed but unauthenticated claude as not ready", async () => {
    const run = fakeRun({
      "claude --version": "2.1.301 (Claude Code)",
      "claude auth status": JSON.stringify({ loggedIn: false }),
    });
    const claude = (await detectAgents({ opencode: "opencode", claude: "claude" }, run)).find((a) => a.id === "claude");
    expect(claude).toMatchObject({ installed: true, ready: false, detail: "not logged in — run `claude` once to sign in" });
  });
});

describe("opencodeModels", () => {
  it("parses provider/model lines, ignoring noise", async () => {
    const run = fakeRun({ "opencode models": "INFO starting\nopencode-admin/glm-5.3\n\nopenai/gpt-5.5\n" });
    expect(await opencodeModels("opencode", run)).toEqual(["opencode-admin/glm-5.3", "openai/gpt-5.5"]);
  });
});

describe("opencodeAgents", () => {
  it("lists selectable agents and skips subagents and hidden ones", async () => {
    const run = fakeRun({
      "opencode debug agents": JSON.stringify([
        { id: "build", mode: "primary", hidden: false },
        { id: "plan", mode: "primary" },
        { id: "ask", mode: "all" },
        { id: "explore", mode: "subagent" },
        { id: "compaction", mode: "primary", hidden: true },
        { id: "bad id", mode: "primary" },
      ]),
    });
    expect(await opencodeAgents("opencode", run)).toEqual(["ask", "build", "plan"]);
  });
});

describe("claudeModels", () => {
  it("parses aliases from /model help, skipping default and prose", async () => {
    const run = fakeRun({
      "claude -p /model --output-format text --bare --no-session-persistence":
        "Current model: `Opus 5.5` (effort: low)\nUsage: /model <name>. Available: sonnet, opus, haiku, fable, best, sonnet[1m], opus[1m], fable[1m], opusplan, default, or a full model ID.\n",
    });
    expect(await claudeModels("claude", run)).toEqual([
      "sonnet",
      "opus",
      "haiku",
      "fable",
      "best",
      "sonnet[1m]",
      "opus[1m]",
      "fable[1m]",
      "opusplan",
    ]);
  });

  it("falls back to known aliases when /model output has no list", async () => {
    const run = fakeRun({
      "claude -p /model --output-format text --bare --no-session-persistence": "I can't switch models from here.",
    });
    expect(await claudeModels("claude", run)).toContain("opus");
  });
});

describe("ensureOpencodeMcp", () => {
  it("registers once and again only when the command changes", async () => {
    const marker = join(await mkdtemp(join(tmpdir(), "ocmcp-")), "opencode-mcp.txt");
    const calls: string[][] = [];
    const run: RunFn = async (_bin, args) => {
      calls.push(args);
      return "";
    };
    expect(await ensureOpencodeMcp("opencode", ["mcp", "add", "switchboard", "a"], marker, run)).toBe("registered");
    expect(await ensureOpencodeMcp("opencode", ["mcp", "add", "switchboard", "a"], marker, run)).toBe("unchanged");
    expect(await ensureOpencodeMcp("opencode", ["mcp", "add", "switchboard", "b"], marker, run)).toBe("registered");
    expect(calls).toHaveLength(2);
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
