import type { HandlerDeps } from "./handler.js";
import { processMessage } from "./handler.js";
import { questionCards } from "./questions.js";
import type { Job } from "./schedules.js";
import type { TranscriptStore } from "./transcripts.js";
import { threadSlug } from "./workspace.js";

export function scheduleThreadKey(jobId: string): string {
  return `schedule/${jobId}`;
}

const SCHEDULED_PREAMBLE =
  "[Scheduled run: this job is already on a schedule. Do the task below now and reply with the result. Do not create schedules, cron jobs or reminders.]";

/**
 * One scheduled run = one turn in the job's own thread. Prompt and replies are
 * recorded so the control plane can show a log; Chat still gets the result when
 * the job targets a real space.
 */
export async function runScheduledJob(job: Job, deps: HandlerDeps, transcripts: TranscriptStore): Promise<boolean> {
  const threadKey = scheduleThreadKey(job.id);
  const ws = deps.workspaces;
  if (job.repo && ws && !deps.store.get(threadKey)?.worktree) {
    const { worktree, branch } = await ws.create(job.repo, threadSlug(`schedule-${job.id}`));
    await deps.store.update(threadKey, job.space, { repo: job.repo, worktree, branch });
  }
  await transcripts.append(threadKey, [{ author: `Schedule "${job.name}"`, text: job.prompt, bot: false }]);
  const { ok } = await processMessage(
    {
      threadKey,
      spaceName: job.space,
      // The prompt often reads like "run X weekly"; without this the agent tries to schedule it instead of doing it.
      text: `${SCHEDULED_PREAMBLE}

${job.prompt}`,
      sender: `Schedule "${job.name}"`,
      // Jobs made from the team chat have no Chat space to post to: the run still happens and is recorded.
      reply: async (text, meta) => {
        await transcripts.append(threadKey, [
          { author: meta?.author ? `@${meta.author}` : "Switchboard", text, bot: true, ...(meta?.questions && { questions: meta.questions }) },
        ]);
        if (job.space.startsWith("spaces/")) {
          await deps.chat.postMessage(job.space, {
            text: meta?.author ? `*@${meta.author}*\n${text}` : text,
            thread: { threadKey: `schedule-${job.id}` },
            ...(meta?.questions?.length && { cardsV2: questionCards(meta.questions) }),
          });
        }
      },
      answerQuestions: false,
    },
    deps,
  );
  return ok;
}
