import { useEffect } from "react";
import { api, type Job } from "./api";

const KEY = "switchboard.jobAlerts";

export function jobAlertsOn(): boolean {
  try {
    return localStorage.getItem(KEY) === "1" && "Notification" in window && Notification.permission === "granted";
  } catch {
    return false;
  }
}

export async function setJobAlerts(on: boolean): Promise<boolean> {
  if (on) {
    if (!("Notification" in window)) return false;
    const permission = Notification.permission === "granted" ? "granted" : await Notification.requestPermission();
    if (permission !== "granted") return false;
  }
  try {
    localStorage.setItem(KEY, on ? "1" : "0");
  } catch {
    return on;
  }
  return on;
}

function finished(job: Job): string | undefined {
  if (job.lastStatus !== "ok" && job.lastStatus !== "failed") return undefined;
  return `${job.lastRunAt}|${job.lastStatus}`;
}

export function useJobAlerts() {
  useEffect(() => {
    let seen: Map<string, string | undefined> | undefined;
    const check = () =>
      api.schedules().then(
        (jobs) => {
          const next = new Map(jobs.map((j) => [j.id, finished(j)]));
          if (seen && jobAlertsOn()) {
            for (const j of jobs) {
              const now = next.get(j.id);
              if (!now || seen.get(j.id) === now) continue;
              const failed = j.lastStatus === "failed";
              const n = new Notification(failed ? `${j.name} failed` : `${j.name} finished`, {
                body: failed ? "Open the job log to see why." : "Results are in the job log.",
                tag: `job-${j.id}`,
              });
              n.onclick = () => {
                window.focus();
                location.hash = "#schedules";
              };
            }
          }
          seen = next;
        },
        () => {},
      );
    void check();
    const id = setInterval(check, 15000);
    return () => clearInterval(id);
  }, []);
}
