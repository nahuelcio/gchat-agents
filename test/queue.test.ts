import { describe, expect, it } from "vitest";
import { TurnQueue } from "../src/queue.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("TurnQueue", () => {
  it("runs same-key tasks strictly serially (second waits for first)", async () => {
    const queue = new TurnQueue();
    const gate = deferred<void>();
    const events: string[] = [];

    const first = queue.run("thread-a", async () => {
      events.push("a1:start");
      await gate.promise;
      events.push("a1:end");
    });
    const second = queue.run("thread-a", async () => {
      events.push("a2:start");
    });

    await Promise.resolve();
    expect(events).toEqual(["a1:start"]);

    gate.resolve();
    await Promise.all([first, second]);
    expect(events).toEqual(["a1:start", "a1:end", "a2:start"]);
  });

  it("runs different keys concurrently", async () => {
    const queue = new TurnQueue();
    const gate = deferred<void>();
    let bDone = false;

    const a = queue.run("thread-a", async () => {
      await gate.promise;
    });
    const b = queue.run("thread-b", async () => {
      bDone = true;
    });

    await b;
    expect(bDone).toBe(true);
    gate.resolve();
    await a;
  });

  it("keeps the queue working after a task rejects", async () => {
    const queue = new TurnQueue();
    const first = queue.run("t", async () => {
      throw new Error("boom");
    });
    await expect(first).rejects.toThrow("boom");
    let ran = false;
    await queue.run("t", async () => {
      ran = true;
    });
    expect(ran).toBe(true);
  });
});
