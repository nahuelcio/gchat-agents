import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Health } from "../src/health.js";

describe("Health", () => {
  it("counts starts and detects a crash when the previous run did not stop cleanly", async () => {
    const file = join(await mkdtemp(join(tmpdir(), "gchat-health-")), "health.json");

    const first = new Health(file, {});
    expect(first.snapshot()).toMatchObject({ starts: 1, crashes: 0, supervised: false });
    // no markStopped(): simulates a crash
    const second = new Health(file, { GCHAT_AGENTS_SUPERVISED: "systemd" });
    expect(second.snapshot()).toMatchObject({ starts: 2, crashes: 1, supervised: true });
    second.markStopped();
    const third = new Health(file, {});
    expect(third.snapshot()).toMatchObject({ starts: 3, crashes: 1 });
  });

  it("reports uptime and the last heartbeat", async () => {
    const file = join(await mkdtemp(join(tmpdir(), "gchat-health-")), "health.json");
    const h = new Health(file, {}, () => new Date("2026-10-16T10:00:00Z"));
    h.beat(new Date("2026-10-16T10:05:00Z"));
    expect(h.snapshot(new Date("2026-10-16T10:05:30Z"))).toMatchObject({ uptimeSec: 330, lastBeatAgoSec: 30 });
  });
});
