import { readFileSync, writeFileSync } from "node:fs";

interface Persisted {
  starts: number;
  crashes: number;
  /** True while the process runs; a start that finds it still true means the last run died. */
  running: boolean;
  lastStartAt?: string;
}

/**
 * Liveness bookkeeping for the control plane. Keeping the process alive is the
 * supervisor's job (systemd `Restart=always`, see scripts/switchboard.service);
 * this records what happened so the team can see it.
 */
export class Health {
  private file: string;
  private state: Persisted;
  private startedAt: Date;
  private lastBeat: Date;
  readonly supervised: boolean;

  constructor(file: string, env: NodeJS.ProcessEnv, now: () => Date = () => new Date()) {
    this.file = file;
    let prev: Persisted = { starts: 0, crashes: 0, running: false };
    try {
      prev = JSON.parse(readFileSync(file, "utf8")) as Persisted;
    } catch {
      // first start
    }
    this.startedAt = now();
    this.lastBeat = this.startedAt;
    // Set by scripts/switchboard.service. (INVOCATION_ID is inherited by anything started from a systemd session, so it proves nothing.)
    this.supervised = env["SWITCHBOARD_SUPERVISED"] === "systemd";
    this.state = {
      starts: prev.starts + 1,
      crashes: prev.crashes + (prev.running ? 1 : 0),
      running: true,
      lastStartAt: this.startedAt.toISOString(),
    };
    this.save();
  }

  beat(at = new Date()): void {
    this.lastBeat = at;
  }

  markStopped(): void {
    this.state.running = false;
    this.save();
  }

  snapshot(now = new Date()) {
    return {
      starts: this.state.starts,
      crashes: this.state.crashes,
      supervised: this.supervised,
      startedAt: this.startedAt.toISOString(),
      uptimeSec: Math.round((now.getTime() - this.startedAt.getTime()) / 1000),
      lastBeatAgoSec: Math.round((now.getTime() - this.lastBeat.getTime()) / 1000),
    };
  }

  private save(): void {
    try {
      writeFileSync(this.file, `${JSON.stringify(this.state)}\n`);
    } catch (err) {
      console.error("[health] could not persist:", err);
    }
  }
}
