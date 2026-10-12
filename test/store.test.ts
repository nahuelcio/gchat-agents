import { existsSync } from "node:fs";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { SessionStore } from "../src/store.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "gchat-store-"));
});

describe("SessionStore", () => {
  it("persists records across instances (atomic write, no tmp leftover)", async () => {
    const file = join(dir, "sessions.json");
    const first = new SessionStore(file);
    await first.set("spaces/S|thread/T", {
      sessionRef: "ses_abc",
      space: "spaces/S",
      updatedAt: "2026-10-12T00:00:00.000Z",
    });

    expect(existsSync(`${file}.tmp`)).toBe(false);
    const onDisk = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
    expect(onDisk["spaces/S|thread/T"]).toMatchObject({ sessionRef: "ses_abc" });

    const second = new SessionStore(file);
    expect(second.get("spaces/S|thread/T")?.sessionRef).toBe("ses_abc");
    expect(second.get("missing")).toBeUndefined();
  });

  it("updates an existing record in place", async () => {
    const file = join(dir, "sessions.json");
    const store = new SessionStore(file);
    await store.set("t1", { sessionRef: "ses_1", space: "spaces/S", updatedAt: "a" });
    await store.set("t1", { sessionRef: "ses_2", space: "spaces/S", updatedAt: "b" });
    expect(store.get("t1")?.sessionRef).toBe("ses_2");
    expect(Object.keys(JSON.parse(await readFile(file, "utf8")) as object)).toEqual(["t1"]);
  });

  it("survives concurrent set() calls from different threads without losing records", async () => {
    const file = join(dir, "sessions.json");
    const store = new SessionStore(file);
    await Promise.all([
      store.set("t1", { sessionRef: "ses_1", space: "spaces/S", updatedAt: "a" }),
      store.set("t2", { sessionRef: "ses_2", space: "spaces/S", updatedAt: "b" }),
    ]);
    const reloaded = new SessionStore(file);
    expect(reloaded.get("t1")?.sessionRef).toBe("ses_1");
    expect(reloaded.get("t2")?.sessionRef).toBe("ses_2");
    expect(existsSync(`${file}.tmp`)).toBe(false);
  });

  it("starts empty on a corrupt file instead of crashing", async () => {
    const file = join(dir, "sessions.json");
    const { writeFile } = await import("node:fs/promises");
    await writeFile(file, "{not json", "utf8");
    const store = new SessionStore(file);
    expect(store.get("anything")).toBeUndefined();
  });
});
