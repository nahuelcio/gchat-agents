import { describeCron, nextRun } from "./schedules.js";
import type { AgentDriver } from "./driver/types.js";

export interface ScheduleSuggestion {
  name: string;
  prompt: string;
  cron: string;
  when: string;
}

/** Asks the configured agent to turn plain language into a schedule job. */
export function suggestPrompt(text: string): string {
  return `You turn a natural-language schedule request into one JSON object for a recurring agent job.
Reply with ONLY valid JSON, no markdown fences, no commentary.
Schema: {"name":"short title ≤48 chars","prompt":"what the agent should do each run","cron":"m h dom mon dow"}
Rules:
- cron is 5 fields, local time (minute hour day-of-month month day-of-week).
- day-of-week: 0=Sunday … 6=Saturday; use 1-5 for weekdays.
- Prefer simple crons: "0 9 * * 1-5", "0 * * * *", "0 8 * * 1", "0 2 * * *".
- prompt is the work instruction only (no schedule wording).
- If the request has no time, default to weekdays at 09:00.

Request:
${text.trim()}`;
}

/** Pulls {name,prompt,cron} out of an agent reply and validates the cron. */
export function parseSuggestion(reply: string): ScheduleSuggestion {
  const match = reply.match(/\{[\s\S]*\}/);
  if (!match) throw new Error("The agent did not return a schedule JSON object.");
  let raw: unknown;
  try {
    raw = JSON.parse(match[0]);
  } catch {
    throw new Error("The agent returned invalid JSON for the schedule.");
  }
  if (!raw || typeof raw !== "object") throw new Error("The agent returned invalid schedule JSON.");
  const obj = raw as Record<string, unknown>;
  const prompt = typeof obj.prompt === "string" ? obj.prompt.trim() : "";
  const cron = typeof obj.cron === "string" ? obj.cron.trim() : "";
  const nameRaw = typeof obj.name === "string" ? obj.name.trim() : "";
  if (!prompt) throw new Error("The suggestion is missing a prompt.");
  if (!cron) throw new Error("The suggestion is missing a cron expression.");
  nextRun(cron, new Date()); // validates fields / that it ever matches
  const name = (nameRaw || prompt).slice(0, 48);
  return { name, prompt, cron, when: describeCron(cron) };
}

export async function suggestSchedule(driver: AgentDriver, text: string, workdir: string): Promise<ScheduleSuggestion> {
  const trimmed = text.trim();
  if (!trimmed) throw new Error("Describe the schedule in plain language first.");
  const result = await driver.runTurn({
    threadKey: `schedule-suggest/${Date.now()}`,
    text: suggestPrompt(trimmed),
    workdir,
    answerQuestions: false,
  });
  return parseSuggestion(result.reply);
}
