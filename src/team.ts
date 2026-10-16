import { processMessage, type HandlerDeps } from "./handler.js";
import type { TranscriptStore } from "./transcripts.js";
import { threadSlug } from "./workspace.js";

/** Team chat threads live under this key prefix (sessions, transcripts). */
export const TEAM_PREFIX = "share/";
export const THREAD_ID = /^[\w-]{8,40}$/;

/**
 * One team-chat message: recorded first (teammates polling see it right away),
 * then run through the same path as a Google Chat message, replies recorded too.
 */
export async function teamSend(
  deps: HandlerDeps,
  transcripts: TranscriptStore,
  req: { thread: string; text: string; name: string; allowCommands?: ReadonlySet<string> },
): Promise<{ ok: boolean; replies: string[] }> {
  const threadKey = `${TEAM_PREFIX}${req.thread}`;
  await transcripts.append(threadKey, [{ author: req.name, text: req.text, bot: false }]);
  const replies: string[] = [];
  const { ok } = await processMessage(
    {
      threadKey,
      spaceName: "team-chat",
      text: req.text,
      sender: req.name,
      reply: async (r) => {
        replies.push(r);
        await transcripts.append(threadKey, [{ author: "gchat-agents", text: r, bot: true }]);
      },
      ...(req.allowCommands && { allowCommands: req.allowCommands }),
    },
    deps,
  );
  return { ok, replies };
}

/** History + live state of one team thread, for the chat view. */
export function teamThread(deps: HandlerDeps, transcripts: TranscriptStore, thread: string) {
  const threadKey = `${TEAM_PREFIX}${thread}`;
  const record = deps.store.get(threadKey);
  return {
    messages: transcripts.get(threadKey),
    agent: record?.driver ?? null,
    repo: record?.repo ?? null,
    branch: record?.branch ?? null,
    busy: deps.queue.busy(threadKey),
  };
}

/**
 * Deletes a team thread: history, agent session, and its worktree (app stopped).
 * The branch stays in the repo so no commit is lost. Queued on the thread so a
 * running turn finishes first instead of re-creating the record afterwards.
 */
export function teamDelete(deps: HandlerDeps, transcripts: TranscriptStore, thread: string): Promise<{ branchKept?: string }> {
  const threadKey = `${TEAM_PREFIX}${thread}`;
  return deps.queue.run(threadKey, async () => {
    const record = deps.store.get(threadKey);
    if (record?.worktree && record.repo && deps.workspaces) {
      deps.workspaces.down(threadSlug(threadKey));
      await deps.workspaces.remove(record.repo, record.worktree).catch((err: unknown) => {
        console.error(`[team ${thread}] worktree removal failed:`, err);
      });
    }
    await deps.store.delete(threadKey);
    await transcripts.remove(threadKey);
    return record?.branch ? { branchKept: record.branch } : {};
  });
}
