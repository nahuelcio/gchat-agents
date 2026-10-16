import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { TranscriptStore } from "../src/transcripts.js";

describe("TranscriptStore", () => {
  it("appends messages per thread and reloads them from disk", async () => {
    const dir = await mkdtemp(join(tmpdir(), "gchat-tx-"));
    const store = new TranscriptStore(dir);
    await store.append("share/abc12345", [{ author: "Ana", text: "hi", bot: false }]);
    await store.append("share/abc12345", [{ author: "gchat-agents", text: "hello", bot: true }]);
    const again = new TranscriptStore(dir);
    expect(again.get("share/abc12345").map((m) => m.text)).toEqual(["hi", "hello"]);
    expect(again.get("share/other123")).toEqual([]);
  });

  it("keeps concurrent appends and caps history", async () => {
    const store = new TranscriptStore(await mkdtemp(join(tmpdir(), "gchat-tx-")), 3);
    await Promise.all([1, 2, 3, 4].map((n) => store.append("share/abc12345", [{ author: "A", text: String(n), bot: false }])));
    expect(store.get("share/abc12345").map((m) => m.text)).toEqual(["2", "3", "4"]);
  });

  it("never turns a thread key into a path outside its folder", async () => {
    const dir = await mkdtemp(join(tmpdir(), "gchat-tx-"));
    const store = new TranscriptStore(dir);
    await store.append("../../evil", [{ author: "A", text: "x", bot: false }]);
    expect(store.fileFor("../../evil").startsWith(dir)).toBe(true);
  });
});
