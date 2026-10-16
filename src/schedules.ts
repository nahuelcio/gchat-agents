import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { rename, unlink, writeFile } from "node:fs/promises";

// --- cron: 5 fields (minute hour day-of-month month day-of-week), local time ---

const FIELDS = [
  { name: "minute", min: 0, max: 59 },
  { name: "hour", min: 0, max: 23 },
  { name: "day-of-month", min: 1, max: 31 },
  { name: "month", min: 1, max: 12 },
  { name: "day-of-week", min: 0, max: 6 },
] as const;

function parseField(expr: string, { name, min, max }: (typeof FIELDS)[number]): Set<number> {
  const values = new Set<number>();
  for (const part of expr.split(",")) {
    const [range = "", stepText] = part.split("/");
    const step = stepText === undefined ? 1 : Number(stepText);
    if (!Number.isInteger(step) || step < 1) throw new Error(`cron ${name}: bad step "${stepText}"`);
    let [lo, hi] = range === "*" ? [min, max] : range.split("-").map(Number) as [number, number | undefined];
    hi ??= stepText === undefined ? lo : max;
    if (!Number.isInteger(lo) || !Number.isInteger(hi) || lo < min || hi > max || lo > hi) {
      throw new Error(`cron ${name}: "${part}" is out of range ${min}-${max}`);
    }
    for (let v = lo; v <= hi; v += step) values.add(v);
  }
  return values;
}

function parseCron(cron: string) {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) throw new Error(`cron must have 5 fields (minute hour day month weekday), got "${cron}"`);
  const [minute, hour, dom, month, dow] = parts.map((p, i) => parseField(p, FIELDS[i]!)) as Set<number>[];
  return { minute: minute!, hour: hour!, dom: dom!, month: month!, dow: dow!, domAny: parts[2] === "*", dowAny: parts[4] === "*" };
}

/** First minute strictly after `from` that matches. */
export function nextRun(cron: string, from: Date): Date {
  const c = parseCron(cron);
  const t = new Date(from);
  t.setSeconds(0, 0);
  t.setMinutes(t.getMinutes() + 1);
  // ponytail: minute-by-minute scan, worst case one year (~525k steps, a few ms); fine for a handful of jobs.
  for (let i = 0; i < 366 * 24 * 60; i++) {
    const dayOk =
      c.domAny && c.dowAny ? true
      : c.domAny ? c.dow.has(t.getDay())
      : c.dowAny ? c.dom.has(t.getDate())
      : c.dom.has(t.getDate()) || c.dow.has(t.getDay()); // standard cron: OR when both are set
    if (c.minute.has(t.getMinutes()) && c.hour.has(t.getHours()) && c.month.has(t.getMonth() + 1) && dayOk) return t;
    t.setMinutes(t.getMinutes() + 1);
  }
  throw new Error(`cron "${cron}" never matches`);
}

/** Common shapes in words; anything else is shown as the expression itself. */
export function describeCron(cron: string): string {
  const m = cron.trim().match(/^(\d+) (\*|\d+) \* \* (\*|1-5|[0-6])$/);
  if (!m) return cron;
  const [, min, hour, dow] = m;
  if (hour === "*") return dow === "*" && min === "0" ? "Every hour" : cron;
  const time = `${hour!.padStart(2, "0")}:${min!.padStart(2, "0")}`;
  const DAYS = ["Sundays", "Mondays", "Tuesdays", "Wednesdays", "Thursdays", "Fridays", "Saturdays"];
  if (dow === "*") return `Every day at ${time}`;
  if (dow === "1-5") return `Weekdays at ${time}`;
  return `${DAYS[Number(dow)]} at ${time}`;
}

// --- jobs ---

export interface Job {
  id: string;
  name: string;
  /** What the agent is asked to do on each run. */
  prompt: string;
  cron: string;
  /** Chat space the result is posted to (one thread per job). */
  space: string;
  repo?: string;
  enabled: boolean;
  createdBy: string;
  createdAt: string;
  nextRunAt?: string;
  lastRunAt?: string;
  lastStatus?: "ok" | "failed" | "running";
  /** Consecutive failures of the current occurrence. */
  failures: number;
}

export type NewJob = Pick<Job, "name" | "prompt" | "cron" | "space" | "createdBy"> & { repo?: string };

const MAX_RETRIES = 3;
const RETRY_MS = 5 * 60_000;

/** Jobs persisted as JSON with atomic writes. */
export class ScheduleStore {
  private filePath: string;
  private jobs: Job[] = [];

  constructor(filePath: string) {
    this.filePath = filePath;
    try {
      this.jobs = JSON.parse(readFileSync(filePath, "utf8")) as Job[];
    } catch {
      // missing or corrupt -> no jobs
    }
  }

  all(): Job[] {
    return this.jobs;
  }

  get(id: string): Job | undefined {
    return this.jobs.find((j) => j.id === id);
  }

  async add(input: NewJob, now = new Date()): Promise<Job> {
    const job: Job = {
      ...input,
      id: randomUUID().slice(0, 8),
      enabled: true,
      createdAt: now.toISOString(),
      nextRunAt: nextRun(input.cron, now).toISOString(), // validates the cron
      failures: 0,
    };
    this.jobs = [...this.jobs, job];
    await this.save();
    return job;
  }

  async update(id: string, patch: Partial<Job>, now = new Date()): Promise<Job> {
    const current = this.get(id);
    if (!current) throw new Error(`no job ${id}`);
    const next = { ...current, ...patch };
    if (patch.cron !== undefined || (patch.enabled && !current.enabled)) {
      next.nextRunAt = nextRun(next.cron, now).toISOString();
      next.failures = 0;
    }
    this.jobs = this.jobs.map((j) => (j.id === id ? next : j));
    await this.save();
    return next;
  }

  async remove(id: string): Promise<void> {
    this.jobs = this.jobs.filter((j) => j.id !== id);
    await this.save();
  }

  private async save(): Promise<void> {
    const tmp = `${this.filePath}.${Date.now()}.tmp`;
    try {
      await writeFile(tmp, `${JSON.stringify(this.jobs, null, 2)}\n`, "utf8");
      await rename(tmp, this.filePath);
    } catch (err) {
      await unlink(tmp).catch(() => {});
      throw err;
    }
  }
}

/** Runs due jobs; `run` resolves true on success. Failures retry 3 times, 5 minutes apart. */
export class Scheduler {
  private store: ScheduleStore;
  private run: (job: Job) => Promise<boolean>;
  private timer?: NodeJS.Timeout;

  constructor(store: ScheduleStore, run: (job: Job) => Promise<boolean>) {
    this.store = store;
    this.run = run;
  }

  start(everyMs = 30_000): void {
    this.timer = setInterval(() => void this.tick(), everyMs);
  }

  stop(): void {
    clearInterval(this.timer);
  }

  async tick(now = new Date()): Promise<void> {
    const due = this.store.all().filter((j) => j.enabled && j.lastStatus !== "running" && j.nextRunAt && new Date(j.nextRunAt) <= now);
    await Promise.all(due.map((job) => this.runNow(job.id, now)));
  }

  /** Runs a job immediately (also used by "Run now"), then reschedules it. */
  async runNow(id: string, now = new Date()): Promise<Job> {
    const job = await this.store.update(id, { lastStatus: "running", lastRunAt: now.toISOString() }, now);
    let ok = false;
    try {
      ok = await this.run(job);
    } catch (err) {
      console.error(`[schedule ${id}] run failed:`, err);
    }
    if (ok) return this.store.update(id, { lastStatus: "ok", failures: 0, nextRunAt: nextRun(job.cron, now).toISOString() }, now);
    const failures = job.failures + 1;
    return failures <= MAX_RETRIES
      ? this.store.update(id, { lastStatus: "failed", failures, nextRunAt: new Date(now.getTime() + RETRY_MS).toISOString() }, now)
      : this.store.update(id, { lastStatus: "failed", failures: 0, nextRunAt: nextRun(job.cron, now).toISOString() }, now);
  }
}
