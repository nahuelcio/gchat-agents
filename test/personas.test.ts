import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { AgentDriver, AgentTurnInput, AgentTurnResult } from "../src/driver/types.js";
import { processMessage, type HandlerDeps } from "../src/handler.js";
import { MAX_HOPS, mentionedPersonas, type Persona } from "../src/personas.js";
import { TurnQueue } from "../src/queue.js";
import { SessionStore } from "../src/store.js";

const ventas: Persona = { name: "ventas", prompt: "You sell." };
const dev: Persona = { name: "dev", prompt: "You code." };

describe("mentionedPersonas", () => {
  it("finds @names in order, case-insensitive, ignoring emails and longer handles", () => {
    expect(mentionedPersonas("@dev and @Ventas, please", [ventas, dev]).map((p) => p.name)).toEqual(["dev", "ventas"]);
    expect(mentionedPersonas("mail me at a@dev.com or ping @developers", [ventas, dev])).toEqual([]);
  });
});

/** Replies with a scripted line per agent (keyed by the turn's `#name` thread suffix). */
class ScriptedDriver implements AgentDriver {
  calls: AgentTurnInput[] = [];
  constructor(private script: (agent: string, n: number) => string) {}
  async runTurn(input: AgentTurnInput): Promise<AgentTurnResult> {
    this.calls.push(input);
    const agent = input.threadKey.split("#")[1] ?? "default";
    const n = this.calls.filter((c) => c.threadKey === input.threadKey).length;
    return { reply: this.script(agent, n), sessionRef: `s-${agent}` };
  }
}

async function run(driver: ScriptedDriver, text: string, personas: Persona[]) {
  const deps: HandlerDeps = {
    verifier: { verify: async () => {} },
    driver,
    chat: { postMessage: async () => ({}) } as unknown as HandlerDeps["chat"],
    store: new SessionStore(join(await mkdtemp(join(tmpdir(), "personas-")), "sessions.json")),
    queue: new TurnQueue(),
    config: { allowedSpaces: [], workdir: "/tmp/wd" },
    options: () => ({ contextFooter: "never", autoCompactAt: 0, personas }),
  };
  const replies: { author?: string; text: string }[] = [];
  await processMessage({ threadKey: "team/t1", spaceName: "team-chat", text, sender: "Ana", reply: async (r, m) => void replies.push({ author: m?.author, text: r }) }, deps);
  return { replies, store: deps.store };
}

describe("@agents in a thread", () => {
  it("routes a mention to that agent, lets it ask another agent, and brings the answer back", async () => {
    const driver = new ScriptedDriver((a, n) => (a === "dev" ? (n === 1 ? "@ventas what does plan X cost?" : "Yes, at $10.") : "Plan X is $10."));
    const { replies, store } = await run(driver, "@dev can we ship plan X?", [ventas, dev]);
    expect(replies).toEqual([
      { author: "dev", text: "@ventas what does plan X cost?" },
      { author: "ventas", text: "Plan X is $10." },
      { author: "dev", text: "Yes, at $10." },
    ]);
    expect(driver.calls[0]!.text).toContain("You are @dev");
    expect(driver.calls[0]!.text).toContain("Ana: @dev can we ship plan X?");
    expect(driver.calls[1]!.text).toMatch(/@dev: @ventas what does plan X cost\?$/);
    expect(driver.calls[2]!.text).toBe("@ventas: Plan X is $10.");
    expect(store.get("team/t1")?.personaSessions).toEqual({ dev: "s-dev", ventas: "s-ventas" });
  });

  it("stops two agents that keep mentioning each other after MAX_HOPS handoffs", async () => {
    const driver = new ScriptedDriver((a) => (a === "dev" ? "@ventas?" : "@dev?"));
    const { replies } = await run(driver, "@dev hi", [ventas, dev]);
    expect(replies).toHaveLength(MAX_HOPS + 1);
  });

  it("leaves messages without a known mention to the default agent", async () => {
    const driver = new ScriptedDriver(() => "hi");
    const { replies } = await run(driver, "hello @nobody", [ventas]);
    expect(replies).toEqual([{ author: undefined, text: "hi" }]);
  });
});
