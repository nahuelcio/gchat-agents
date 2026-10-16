import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { describeCron, nextRun, ScheduleStore, Scheduler, type Job } from "../src/schedules.js";

const at = (iso: string) => new Date(iso);

describe("nextRun", () => {
  it("handles steps, ranges and lists in local time", () => {
    expect(nextRun("*/15 * * * *", at("2026-10-16T10:07:30")).toISOString()).toBe(at("2026-10-16T10:15:00").toISOString());
    expect(nextRun("0 9 * * 1-5", at("2026-10-16T09:00:00")).toISOString()).toBe(at("2026-10-19T09:00:00").toISOString()); // Fri -> Mon
    expect(nextRun("30 8,17 * * *", at("2026-10-16T09:00:00")).toISOString()).toBe(at("2026-10-16T17:30:00").toISOString());
  });

  it("ORs day-of-month and day-of-week when both are restricted (standard cron)", () => {
    // 1st of the month OR any Monday: from Fri Oct 16 the next match is Mon Oct 19.
    expect(nextRun("0 0 1 * 1", at("2026-10-16T12:00:00")).toISOString()).toBe(at("2026-10-19T00:00:00").toISOString());
  });

  it("rejects malformed expressions", () => {
    expect(() => nextRun("* * *", new Date())).toThrow(/5 fields/);
    expect(() => nextRun("61 * * * *", new Date())).toThrow(/out of range/);
    expect(() => nextRun("*/0 * * * *", new Date())).toThrow(/step/);
  });
});

describe("describeCron", () => {
  it("says common schedules in words", () => {
    expect(describeCron("0 9 * * 1-5")).toBe("Weekdays at 09:00");
    expect(describeCron("0 * * * *")).toBe("Every hour");
    expect(describeCron("0 2 * * *")).toBe("Every day at 02:00");
    expect(describeCron("0 8 * * 1")).toBe("Mondays at 08:00");
    expect(describeCron("7 3 1 * *")).toBe("7 3 1 * *");
  });
});

describe("Scheduler", () => {
  async function setup(outcomes: boolean[]) {
    const dir = await mkdtemp(join(tmpdir(), "gchat-sched-"));
    const store = new ScheduleStore(join(dir, "schedules.json"));
    const runs: Job[] = [];
    const scheduler = new Scheduler(store, async (job) => {
      runs.push(job);
      return outcomes.shift() ?? true;
    });
    return { store, scheduler, runs, dir };
  }

  it("runs due jobs once, records success and schedules the next occurrence", async () => {
    const { store, scheduler, runs } = await setup([true]);
    const job = await store.add({ name: "Standup", prompt: "summarize", cron: "0 9 * * 1-5", space: "spaces/T", createdBy: "Ana" }, at("2026-10-16T08:00:00"));
    expect(job.nextRunAt).toBe(at("2026-10-16T09:00:00").toISOString());

    await scheduler.tick(at("2026-10-16T08:59:00"));
    expect(runs).toHaveLength(0);
    await scheduler.tick(at("2026-10-16T09:00:10"));
    expect(runs).toHaveLength(1);
    const after = store.get(job.id)!;
    expect(after).toMatchObject({ lastStatus: "ok", failures: 0, nextRunAt: at("2026-10-19T09:00:00").toISOString() });
  });

  it("retries failures 3 times, 5 minutes apart, then waits for the next occurrence", async () => {
    const { store, scheduler } = await setup([false, false, false, false]);
    const job = await store.add({ name: "Tests", prompt: "run", cron: "0 2 * * *", space: "spaces/T", createdBy: "Nahuel" }, at("2026-10-16T01:00:00"));
    let now = at("2026-10-16T02:00:00");
    for (let attempt = 1; attempt <= 3; attempt++) {
      await scheduler.tick(now);
      const j = store.get(job.id)!;
      expect(j).toMatchObject({ lastStatus: "failed", failures: attempt });
      expect(j.nextRunAt).toBe(new Date(now.getTime() + 5 * 60_000).toISOString());
      now = new Date(j.nextRunAt!);
    }
    await scheduler.tick(now);
    expect(store.get(job.id)).toMatchObject({ failures: 0, nextRunAt: at("2026-10-17T02:00:00").toISOString() });
  });

  it("skips paused jobs and persists across reloads", async () => {
    const { store, scheduler, runs, dir } = await setup([]);
    const job = await store.add({ name: "Deps", prompt: "check", cron: "* * * * *", space: "spaces/T", createdBy: "Ana" }, at("2026-10-16T10:00:00"));
    await store.update(job.id, { enabled: false });
    await scheduler.tick(at("2026-10-16T11:00:00"));
    expect(runs).toHaveLength(0);
    expect(new ScheduleStore(join(dir, "schedules.json")).get(job.id)?.enabled).toBe(false);
  });

  it("validates the cron when adding", async () => {
    const { store } = await setup([]);
    await expect(store.add({ name: "x", prompt: "y", cron: "nope", space: "spaces/T", createdBy: "a" })).rejects.toThrow(/5 fields/);
  });
});
