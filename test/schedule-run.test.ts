import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { EchoDriver } from "../src/driver/echo.js";
import type { HandlerDeps } from "../src/handler.js";
import { TurnQueue } from "../src/queue.js";
import { runScheduledJob, scheduleThreadKey } from "../src/schedule-run.js";
import type { Job } from "../src/schedules.js";
import { SessionStore } from "../src/store.js";
import { TranscriptStore } from "../src/transcripts.js";

describe("runScheduledJob", () => {
  it("records the prompt and agent reply in the job transcript and posts to Chat spaces", async () => {
    const dir = await mkdtemp(join(tmpdir(), "gchat-schedule-run-"));
    const posted: { space: string; text: string }[] = [];
    const transcripts = new TranscriptStore(join(dir, "transcripts"));
    const deps: HandlerDeps = {
      verifier: { verify: async () => {} },
      driver: new EchoDriver(),
      chat: {
        postMessage: async (space, body) => {
          posted.push({ space, text: body.text });
        },
      },
      store: new SessionStore(join(dir, "sessions.json")),
      queue: new TurnQueue(),
      config: { allowedSpaces: ["spaces/AAA"], workdir: dir },
      options: () => ({ contextFooter: "never", autoCompactAt: 0 }),
    };
    const job: Job = {
      id: "job1",
      name: "Weekly retro",
      prompt: "Run the weekly retro",
      cron: "0 9 * * 1-5",
      space: "spaces/AAA",
      enabled: true,
      createdBy: "control plane",
      failures: 0,
    };

    expect(await runScheduledJob(job, deps, transcripts)).toBe(true);
    expect(transcripts.get(scheduleThreadKey(job.id))).toEqual([
      expect.objectContaining({ author: 'Schedule "Weekly retro"', text: "Run the weekly retro", bot: false }),
      expect.objectContaining({ author: "Switchi", text: expect.stringMatching(/^Echo: Schedule "Weekly retro": \[Scheduled run[^]*Run the weekly retro$/), bot: true }),
    ]);
    expect(posted).toEqual([
      { space: "spaces/AAA", text: expect.stringMatching(/^Echo: Schedule "Weekly retro": \[Scheduled run[^]*Run the weekly retro$/) },
    ]);
  });

  it("still records a log when the job has no Chat space", async () => {
    const dir = await mkdtemp(join(tmpdir(), "gchat-schedule-run-"));
    const transcripts = new TranscriptStore(join(dir, "transcripts"));
    const deps: HandlerDeps = {
      verifier: { verify: async () => {} },
      driver: new EchoDriver(),
      chat: { postMessage: async () => {} },
      store: new SessionStore(join(dir, "sessions.json")),
      queue: new TurnQueue(),
      config: { allowedSpaces: [], workdir: dir },
      options: () => ({ contextFooter: "never", autoCompactAt: 0 }),
    };
    const job: Job = {
      id: "job2",
      name: "Local",
      prompt: "hello",
      cron: "0 * * * *",
      space: "team-chat",
      enabled: true,
      createdBy: "me",
      failures: 0,
    };

    expect(await runScheduledJob(job, deps, transcripts)).toBe(true);
    expect(transcripts.get(scheduleThreadKey(job.id)).map((m) => m.text)).toEqual([
      "hello",
      expect.stringMatching(/^Echo: Schedule "Local": \[Scheduled run[^]*hello$/),
    ]);
  });
});
