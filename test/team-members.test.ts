import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { HandlerDeps } from "../src/handler.js";
import { EchoDriver } from "../src/driver/echo.js";
import { TurnQueue } from "../src/queue.js";
import { SessionStore } from "../src/store.js";
import { teamInvite, teamMembers, teamSend, teamThread } from "../src/team.js";
import { TranscriptStore } from "../src/transcripts.js";

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), "members-"));
  const deps: HandlerDeps = {
    verifier: { verify: async () => {} },
    driver: new EchoDriver(),
    chat: { postMessage: async () => ({}) } as unknown as HandlerDeps["chat"],
    store: new SessionStore(join(dir, "sessions.json")),
    queue: new TurnQueue(),
    config: { allowedSpaces: [], workdir: dir },
    options: () => ({ contextFooter: "never", autoCompactAt: 0, personas: [{ name: "qa", prompt: "" }, { name: "dev", prompt: "" }] }),
  };
  return { deps, transcripts: new TranscriptStore(join(dir, "transcripts")) };
}

describe("team room members", () => {
  it("a new room starts with whoever writes and no agents; the owner adds and removes agents", async () => {
    const { deps, transcripts } = await setup();
    await teamSend(deps, transcripts, { thread: "room-0001", text: "hola", name: "Ana" });
    expect((await teamThread(deps, transcripts, "room-0001")).members?.map((m) => m.id)).toEqual(["human:ana"]);

    await teamMembers(deps, "room-0001", "add", { kind: "agent", persona: "@qa" });
    await teamMembers(deps, "room-0001", "add", { kind: "agent", persona: "dev" });
    await teamMembers(deps, "room-0001", "remove", { kind: "agent", persona: "qa" });
    expect((await teamThread(deps, transcripts, "room-0001")).members?.map((m) => m.id)).toEqual(["human:ana", "agent:dev"]);
    await expect(teamMembers(deps, "room-0001", "add", { kind: "agent", persona: "nope" })).rejects.toThrow(/no agent @nope/);
  });
});

describe("invite_agent", () => {
  it("re-adds a removed agent only when a person asked for it", async () => {
    const { deps, transcripts } = await setup();
    await teamSend(deps, transcripts, { thread: "room-0002", text: "hola", name: "Ana" });
    await teamMembers(deps, "room-0002", "add", { kind: "agent", persona: "qa" });
    await teamMembers(deps, "room-0002", "remove", { kind: "agent", persona: "qa" });
    expect(deps.store.get("share/room-0002")?.kicked).toEqual(["qa"]);
    await deps.store.update("share/room-0002", "team-chat", { room: [{ n: 1, author: "Ana", text: "seguimos" }] });
    await expect(teamInvite(deps, "share/room-0002#dev", "qa")).rejects.toThrow(/only a person/);
    await deps.store.update("share/room-0002", "team-chat", { room: [{ n: 1, author: "Ana", text: "agregá a @qa" }, { n: 2, author: "@dev", text: "ok" }] });
    const members = await teamInvite(deps, "share/room-0002", "@qa");
    expect(members.map((m) => m.id)).toContain("agent:qa");
    expect(deps.store.get("share/room-0002")?.kicked).toEqual([]);
  });
});
