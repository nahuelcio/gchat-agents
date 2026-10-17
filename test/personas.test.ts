import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { AgentDriver, AgentTurnInput, AgentTurnResult } from "../src/driver/types.js";
import { processMessage, type HandlerDeps } from "../src/handler.js";
import { BOT_NAME, MAX_DIALOGUE_HOPS, MAX_HOPS, addressedPersonas, askedPersonas, mentionedPersonas, requestStop, type Persona } from "../src/personas.js";
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

describe("askedPersonas", () => {
  it("counts a question to @name, not a passing mention", () => {
    const names = (t: string) => askedPersonas(t, [ventas, dev]).map((p) => p.name);
    expect(names("Perfecto, @dev. Cuando Nahuel defina el alcance te paso lo de UI.")).toEqual([]);
    expect(names("Te ayudo a coordinar con @dev en lo que sea UI.")).toEqual([]);
    expect(names("No manejo precios.\n\n@ventas ¿Cuánto cuesta el plan Pro?")).toEqual(["ventas"]);
    expect(names("@dev revisá el login por favor.")).toEqual(["dev"]);
    expect(names("¿Me pasás el precio, @ventas?")).toEqual(["ventas"]);
  });
});

describe("addressedPersonas", () => {
  const architect: Persona = { name: "architect", prompt: "You design." };
  it("routes dialogue intents and multi-agent invites; talk-about goes to the host first", () => {
    const names = (t: string) => addressedPersonas(t, [ventas, dev, architect]).map((p) => p.name);
    expect(names("habla con architect")).toEqual(["architect"]);
    expect(names("@dev habla con architect sobre Effect")).toEqual(["dev", "architect"]);
    expect(names("@dev @ventas discutan el precio")).toEqual(["dev", "ventas"]);
    expect(names("qué opinas de lo que dijo architect?")).toEqual([]);
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

async function depsFor(driver: ScriptedDriver, personas: Persona[]): Promise<HandlerDeps> {
  return {
    verifier: { verify: async () => {} },
    driver,
    chat: { postMessage: async () => ({}) } as unknown as HandlerDeps["chat"],
    store: new SessionStore(join(await mkdtemp(join(tmpdir(), "personas-")), "sessions.json")),
    queue: new TurnQueue(),
    config: { allowedSpaces: [], workdir: "/tmp/wd" },
    options: () => ({ contextFooter: "never", autoCompactAt: 0, personas }),
  };
}

async function run(driver: ScriptedDriver, text: string, personas: Persona[]) {
  const deps = await depsFor(driver, personas);
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

  it("brings the answer back when the person mentioned both agents", async () => {
    const driver = new ScriptedDriver((a, n) => (a === "dev" ? (n === 1 ? "@ventas price?" : "Done: $10.") : "$10."));
    const { replies } = await run(driver, "@dev ask @ventas the price", [ventas, dev]);
    expect(replies.map((r) => r.author)).toEqual(["dev", "ventas", "dev"]);
    expect(driver.calls[1]!.text).toContain("@dev: @ventas price?");
  });

  it("discussion: two @agents pass the floor even without @asking each other", async () => {
    const driver = new ScriptedDriver((a, n) => (n >= 2 ? "PASS" : a === "dev" ? "Dev: ship at $10." : "Ventas: agreed, $10."));
    const { replies } = await run(driver, "@dev @ventas discutan el precio", [ventas, dev]);
    expect(replies.map((r) => r.author)).toEqual(["dev", "ventas"]);
    expect(driver.calls[0]!.text).toContain("[Discussion with @dev, @ventas]");
    expect(driver.calls[1]!.text).toContain("[Discussion] @dev just said:");
    expect(driver.calls[1]!.text).toContain("Dev: ship at $10.");
  });

  it("discussion stops at MAX_DIALOGUE_HOPS when agents keep talking", async () => {
    const driver = new ScriptedDriver((a) => (a === "dev" ? "Dev still thinking." : "Ventas still thinking."));
    const { replies } = await run(driver, "@dev @ventas discutan", [ventas, dev]);
    expect(replies).toHaveLength(MAX_DIALOGUE_HOPS + 1);
  });

  it("host consults a named agent when you ask about them, then they dialogue", async () => {
    const architect: Persona = { name: "architect", prompt: "You design." };
    const driver = new ScriptedDriver((a, n) => {
      if (a === "default") return n === 1 ? "Host take." : "Host reacts.";
      return n === 1 ? "Architect take." : "PASS";
    });
    const { replies } = await run(driver, "qué opinas de architect sobre Effect?", [architect]);
    expect(replies.map((r) => r.author)).toEqual([undefined, "architect", undefined]);
    expect(driver.calls.some((c) => c.threadKey.endsWith("#architect") && c.text.includes("[Consultation]"))).toBe(true);
    expect(driver.calls.some((c) => c.threadKey === "team/t1" && c.text.includes("@architect"))).toBe(true);
  });

  it("listen:all agents can jump in after an @conversation with someone else", async () => {
    const architect: Persona = { name: "architect", prompt: "You design." };
    const qa: Persona = { name: "qa", prompt: "You test.", listen: "all" };
    const driver = new ScriptedDriver((a) => (a === "architect" ? "Arch view." : a === "qa" ? "QA jumps in." : "default"));
    const { replies } = await run(driver, "@architect thoughts on Effect?", [architect, qa]);
    expect(replies.map((r) => r.author)).toEqual(["architect", "qa"]);
    expect(driver.calls.find((c) => c.threadKey.endsWith("#qa"))!.text).toContain("[Room message");
  });

  it("an agent can @ the host mid-discussion to bring them back", async () => {
    const architect: Persona = { name: "architect", prompt: "You design." };
    const driver = new ScriptedDriver((a, n) => {
      if (a === "architect") return n === 1 ? `@${BOT_NAME} do you agree on Effect?` : "PASS";
      return n === 1 ? "Host open." : "Host agrees with architect.";
    });
    // Direct @architect — no host first; architect asks host back.
    const { replies } = await run(driver, "@architect Effect?", [architect]);
    expect(replies.map((r) => r.author)).toEqual(["architect", undefined]);
    expect(replies[1]!.text).toMatch(/Host/);
    expect(driver.calls.filter((c) => c.threadKey === "team/t1").length).toBeGreaterThanOrEqual(1);
  });

  it("treats an answer that names the asker as the answer, not a new question", async () => {
    const driver = new ScriptedDriver((a, n) => (a === "dev" ? (n === 1 ? "@ventas price?" : "Done.") : "@dev: $10."));
    const { replies } = await run(driver, "@dev get the price", [ventas, dev]);
    expect(replies.map((r) => r.author)).toEqual(["dev", "ventas", "dev"]);
  });

  it("room mode: a listening agent gets unaddressed messages and stays quiet with PASS", async () => {
    const listener: Persona = { name: "qa", prompt: "You test.", listen: "all" };
    const driver = new ScriptedDriver((a, n) => (a === "qa" ? (n === 1 ? "PASS" : "I'd add a test.") : "default reply"));
    const first = await run(driver, "hola", [listener]);
    expect(first.replies).toEqual([{ author: undefined, text: "default reply" }]);
    expect(driver.calls[1]!.text).toContain("[Room message");
    expect(driver.calls[1]!.text).toContain("reply exactly PASS");
  });

  it("people-only agents ignore questions from other agents", async () => {
    const shy: Persona = { ...ventas, respondTo: "people" };
    const driver = new ScriptedDriver((a) => (a === "dev" ? "@ventas price?" : "$10."));
    const { replies } = await run(driver, "@dev get the price", [shy, dev]);
    expect(replies.map((r) => r.author)).toEqual(["dev"]);
  });

  it("Stop ends the round before the next agent answers", async () => {
    const driver = new ScriptedDriver((a) => {
      if (a === "dev") requestStop("team/t1");
      return a === "dev" ? "@ventas price?" : "$10.";
    });
    const { replies } = await run(driver, "@dev get the price", [ventas, dev]);
    expect(replies).toEqual([
      { author: "dev", text: "@ventas price?" },
      { author: undefined, text: "Stopped. @ventas did not answer." },
    ]);
  });

  it("shared room: the default agent catches up on what an @agent said earlier in the thread", async () => {
    const plan: Persona = { name: "plan", prompt: "You plan." };
    const driver = new ScriptedDriver((a) => (a === "plan" ? "Step 1: write tests." : "ok"));
    const deps = await depsFor(driver, [plan]);
    const say = (text: string) => processMessage({ threadKey: "team/t1", spaceName: "team-chat", text, sender: "Ana", reply: async () => {} }, deps);
    await say("@plan what first?");
    await say("can you read what plan said?");
    const last = driver.calls.at(-1)!;
    expect(last.threadKey).toBe("team/t1");
    expect(last.text).toContain("@plan: Step 1: write tests.");
    expect(last.text).toContain("Ana: @plan what first?");
    expect(last.text).toMatch(/Ana: can you read what plan said\?$/);
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

describe("room members", () => {
  it("only agent members answer @mentions and room mode; a room without a member list keeps the whole catalog", async () => {
    const qa: Persona = { name: "qa", prompt: "You test.", listen: "all" };
    const driver = new ScriptedDriver((a) => (a === "default" ? "default reply" : `${a} here`));
    const deps = await depsFor(driver, [ventas, dev, qa]);
    await deps.store.update("team/t1", "team-chat", {
      members: [
        { kind: "human", id: "human:ana", name: "Ana", joinedAt: "x" },
        { kind: "agent", id: "agent:dev", persona: "dev", joinedAt: "x" },
      ],
    });
    const replies: (string | undefined)[] = [];
    const say = (text: string) =>
      processMessage({ threadKey: "team/t1", spaceName: "team-chat", text, sender: "Ana", reply: async (_r, m) => void replies.push(m?.author) }, deps);
    await say("@ventas price?");
    await say("@dev hi");
    expect(replies).toEqual([undefined, "dev"]); // @ventas is not in the room -> default agent; qa (room mode) is not a member
    expect(driver.calls.some((c) => c.threadKey.endsWith("#qa") || c.threadKey.endsWith("#ventas"))).toBe(false);

    const legacy = await run(new ScriptedDriver(() => "ok"), "@ventas price?", [ventas]);
    expect(legacy.replies[0]!.author).toBe("ventas");
  });
});

describe("parallel rooms", () => {
  class TimedDriver implements AgentDriver {
    calls: AgentTurnInput[] = [];
    constructor(private plan: (agent: string, n: number) => { reply: string; ms: number }) {}
    async runTurn(input: AgentTurnInput): Promise<AgentTurnResult> {
      this.calls.push(input);
      const agent = input.threadKey.split("#")[1] ?? "default";
      const n = this.calls.filter((c) => c.threadKey === input.threadKey).length;
      const { reply, ms } = this.plan(agent, n);
      await new Promise((r) => setTimeout(r, ms));
      return { reply, sessionRef: `s-${agent}` };
    }
  }

  const qa: Persona = { name: "qa", prompt: "You test." };
  const members = (...names: string[]) => [
    { kind: "human" as const, id: "human:ana", name: "Ana", joinedAt: "x" },
    ...names.map((n) => ({ kind: "agent" as const, id: `agent:${n}`, persona: n, joinedAt: "x" })),
  ];

  it("agents asked together answer in parallel, post in completion order, and reach the asker in one turn", async () => {
    const driver = new TimedDriver((a, n) => {
      if (a === "default") return { reply: n === 1 ? "@dev ¿opinás? @qa ¿opinás?" : "x", ms: 1 };
      if (a === "dev") return { reply: "dev says slow", ms: 120 };
      return { reply: "qa says fast", ms: 10 };
    });
    const deps = await depsFor(driver as unknown as ScriptedDriver, [dev, qa]);
    await deps.store.update("team/t1", "team-chat", { members: members("dev", "qa") });
    const posted: (string | undefined)[] = [];
    const started = Date.now();
    await processMessage({ threadKey: "team/t1", spaceName: "team-chat", text: "what do you all think about X", sender: "Ana", reply: async (_r, m) => void posted.push(m?.author) }, deps);
    const elapsed = Date.now() - started;
    expect(posted.slice(0, 3)).toEqual([undefined, "qa", "dev"]);
    expect(elapsed).toBeLessThan(230);
    const back = driver.calls.filter((c) => c.threadKey === "team/t1").at(-1)!;
    expect(back.text).toContain("@qa: qa says fast");
    expect(back.text).toContain("@dev: dev says slow");
    expect(driver.calls.filter((c) => c.threadKey === "team/t1")).toHaveLength(2);
  });

  it("the host gets the roster once, then only appended room updates", async () => {
    const driver = new ScriptedDriver(() => "ok");
    const deps = await depsFor(driver, [dev, qa]);
    await deps.store.update("team/t1", "team-chat", { members: members("dev") });
    const say = (text: string) => processMessage({ threadKey: "team/t1", spaceName: "team-chat", text, sender: "Ana", reply: async () => {} }, deps);
    await say("hola");
    expect(driver.calls[0]!.text.startsWith("You are Switchi, the host")).toBe(true);
    expect(driver.calls[0]!.text).toContain("@dev (You code.)");
    await deps.store.update("team/t1", "team-chat", { members: members("dev", "qa"), sessionRef: "s-default" });
    await say("y ahora?");
    expect(driver.calls[1]!.text.startsWith("You are Switchi")).toBe(false);
    expect(driver.calls[1]!.text).toMatch(/\[Room update: @qa joined\]$/);
  });

  it("caps chime-ins from listening agents at one", async () => {
    const a: Persona = { name: "a1", prompt: "", listen: "all" };
    const b: Persona = { name: "b1", prompt: "", listen: "all" };
    const driver = new ScriptedDriver((who) => (who === "default" ? "host" : `${who} has an opinion`));
    const deps = await depsFor(driver, [a, b]);
    const posted: (string | undefined)[] = [];
    await processMessage({ threadKey: "team/t1", spaceName: "team-chat", text: "random topic", sender: "Ana", reply: async (_r, m) => void posted.push(m?.author) }, deps);
    expect(posted.filter(Boolean)).toHaveLength(1);
  });

  it("a removed agent is not called by people or agents, and the person is told", async () => {
    const driver = new ScriptedDriver((who) => (who === "dev" ? "@qa ¿lo probás?" : "ok"));
    const deps = await depsFor(driver, [dev, qa]);
    await deps.store.update("team/t1", "team-chat", { members: members("dev"), kicked: ["qa"] });
    const replies: string[] = [];
    const say = (text: string) => processMessage({ threadKey: "team/t1", spaceName: "team-chat", text, sender: "Ana", reply: async (r) => void replies.push(r) }, deps);
    await say("@qa probá esto");
    expect(replies[0]).toMatch(/@qa isn't in this room/);
    await say("@dev hacé el login");
    expect(driver.calls.some((c) => c.threadKey.endsWith("#qa"))).toBe(false);
  });
});

describe("members that change during a turn", () => {
  it("an agent invited during the host's turn can answer the host's question in that same message", async () => {
    const designer: Persona = { name: "designer", prompt: "" };
    let deps: HandlerDeps;
    const driver = new ScriptedDriver((who) => {
      if (who === "default") {
        void deps.store.update("team/t1", "team-chat", {
          members: [
            { kind: "human", id: "human:ana", name: "Ana", joinedAt: "x" },
            { kind: "agent", id: "agent:designer", persona: "designer", joinedAt: "x" },
          ],
        });
        return "Listo, volvió. @designer ¿confirmás lo de los colores?";
      }
      return "Confirmado.";
    });
    deps = await depsFor(driver, [designer]);
    await deps.store.update("team/t1", "team-chat", { members: [{ kind: "human", id: "human:ana", name: "Ana", joinedAt: "x" }], kicked: ["designer"] });
    const authors: (string | undefined)[] = [];
    await processMessage({ threadKey: "team/t1", spaceName: "team-chat", text: "agregá a @designer", sender: "Ana", reply: async (_r, m) => void authors.push(m?.author) }, deps);
    expect(authors).toContain("designer");
  });
});
