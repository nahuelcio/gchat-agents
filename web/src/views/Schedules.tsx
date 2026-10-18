import { useEffect, useRef, useState } from "react";
import { agentTint, BOT_NAME } from "../agent-color";
import { ago, api, duration, until, type Health, type Job, type JobTrigger, type ScheduleLogMessage } from "../api";
import { hashQuery, type ViewProps } from "../App";

const TRIGGERS: { value: JobTrigger; label: string }[] = [
  { value: "cron", label: "On a schedule" },
  { value: "command", label: "When someone writes /command" },
  { value: "mention", label: "When a message contains…" },
];

const PRESETS = [
  { label: "Every hour", cron: "0 * * * *" },
  { label: "Weekdays at 09:00", cron: "0 9 * * 1-5" },
  { label: "Mondays at 08:00", cron: "0 8 * * 1" },
  { label: "Every day at 02:00", cron: "0 2 * * *" },
];

const RECIPES: {
  id: string;
  label: string;
  blurb: string;
  cron: string;
  prompt: string;
  /** Prefill the first configured repo when applying. */
  preferRepo?: boolean;
}[] = [
  {
    id: "my-board",
    label: "My board (Dev / QA)",
    blurb: "Weekday AM: your ADO tickets In Dev and In QA via @cioffinahuel/opencode-ado.",
    cron: "0 9 * * 1-5",
    prompt: [
      "Use the shell (coding tools). Do NOT invent work items.",
      "Prerequisite: Azure DevOps saved in Switchboard Settings (or `ado` already configured). The `ado` CLI is on PATH via `@cioffinahuel/opencode-ado`.",
      "Run:",
      `  ado wi list --assigned @Me --state "In Dev"`,
      `  ado wi list --assigned @Me --state "In QA"`,
      "If a state name fails, retry once with the board's real labels (still Dev/QA-like) and say which names worked.",
      "If the CLI errors (no PAT / not configured), print the error and tell the user to save org+PAT in Settings → Repos.",
      "Reply in Spanish, short:",
      "## In Dev — con qué seguís",
      "- one bullet per item: #id title (link). If none: (vacío)",
      "## In QA — qué estuvo / está en prueba",
      "- same shape",
      "End with one line: Prioridad sugerida: … (at most one In Dev item, or nada urgente).",
    ].join("\n"),
  },
  {
    id: "repo-digest",
    label: "Repo digest",
    blurb: "Weekday AM: commits since yesterday, dirty tree, and concrete blockers.",
    cron: "0 9 * * 1-5",
    preferRepo: true,
    prompt: [
      "You have a git worktree for this job. Do the work with tools — do not invent commits or PR links.",
      "1) git log --since='24 hours ago' --oneline --no-merges (and note the branch).",
      "2) git status -sb; list dirty paths only if any.",
      "3) If gh is available: gh pr list --state open --limit 10; otherwise say PRs unchecked.",
      "Reply in 3 short sections: Shipped / In flight / Blockers. Max ~15 lines. No fluff.",
    ].join("\n"),
  },
  {
    id: "ship-check",
    label: "Friday ship check",
    blurb: "What can merge before the weekend, what is stuck, what is risky.",
    cron: "0 16 * * 5",
    preferRepo: true,
    prompt: [
      "Friday ship check on this worktree. Use git/gh tools; do not invent.",
      "1) Current branch + git status -sb.",
      "2) Commits on this branch not in main/master (pick the default): git log --oneline main..HEAD or master..HEAD.",
      "3) If gh works: open PRs touching this repo and any failing checks you can see.",
      "Reply as: Ready to merge / Needs work / Leave it (with one-line why each). Flag anything unsafe to leave over the weekend.",
    ].join("\n"),
  },
];

function status(job: Job): { label: string; tone: string } {
  if (!job.enabled) return { label: "Paused", tone: "" };
  if (job.lastStatus === "running") return { label: "Running", tone: "info" };
  if (job.lastStatus === "failed") return { label: job.failures ? `Failed · retry ${job.failures} of 3` : "Failed", tone: "bad" };
  if (job.lastStatus === "ok") return { label: "Succeeded", tone: "ok" };
  if (job.pending) return { label: "Waiting for approval", tone: "warn" };
  if (job.lastStatus === "denied") return { label: "Denied", tone: "" };
  return { label: job.trigger === "cron" ? "Scheduled" : "Listening", tone: "accent" };
}

/** Not a Chat space: the run is only recorded in the job log (see schedule-run.ts). */
const TEAM_ONLY = "team-chat";

export function Schedules({ settings, notify }: ViewProps) {
  const [jobs, setJobs] = useState<Job[]>();
  const [health, setHealth] = useState<Health>();
  const [open, setOpen] = useState(false);
  const [suggesting, setSuggesting] = useState(false);
  const [aiDraft, setAiDraft] = useState("");
  const [form, setForm] = useState({
    prompt: "",
    cron: PRESETS[1]!.cron,
    space: settings.allowedSpaces[0] ?? TEAM_ONLY,
    repo: "",
    trigger: "cron" as JobTrigger,
    command: "",
    pattern: "",
    needsApproval: false,
  });
  const [logId, setLogId] = useState<string>();
  const [logMessages, setLogMessages] = useState<ScheduleLogMessage[]>();
  const deepLinkHandled = useRef(false);

  useEffect(() => {
    const load = () => {
      api.schedules().then(setJobs, () => setJobs([]));
      api.health().then(setHealth, () => {});
    };
    load();
    const id = setInterval(load, 5000);
    return () => clearInterval(id);
  }, []);

  const applyRecipe = (id: string) => {
    const recipe = RECIPES.find((r) => r.id === id);
    if (!recipe) return;
    const firstRepo = Object.keys(settings.repos)[0] ?? "";
    setForm((f) => ({
      ...f,
      prompt: recipe.prompt,
      cron: recipe.cron,
      trigger: "cron",
      space: f.space || settings.allowedSpaces[0] || TEAM_ONLY,
      repo: recipe.preferRepo ? f.repo || firstRepo : f.repo,
    }));
    setOpen(true);
    setAiDraft("");
    notify(`Recipe: ${recipe.label} — review cron/repo, then create`);
  };

  useEffect(() => {
    if (deepLinkHandled.current) return;
    const q = hashQuery();
    const recipe = q.get("recipe");
    const wantNew = q.get("new") === "1" || Boolean(recipe);
    if (!wantNew && !recipe) return;
    deepLinkHandled.current = true;
    if (recipe) applyRecipe(recipe);
    else setOpen(true);
    history.replaceState(null, "", "#schedules");
    // eslint-disable-next-line react-hooks/exhaustive-deps -- deep-link once on mount
  }, []);

  useEffect(() => {
    if (!logId) {
      setLogMessages(undefined);
      return;
    }
    const load = () => api.scheduleLog(logId).then((r) => setLogMessages(r.messages), (err: Error) => notify(err.message, true));
    load();
    const id = setInterval(load, 2000);
    return () => clearInterval(id);
  }, [logId, notify]);

  const act = (p: Promise<Job[]>, ok: string) =>
    p.then(
      (list) => {
        setJobs(list);
        notify(ok);
      },
      (err: Error) => notify(err.message, true),
    );

  function fillWithAi() {
    const text = aiDraft.trim();
    if (!text || suggesting) return;
    setSuggesting(true);
    api
      .suggestSchedule(text)
      .then((s) => {
        setForm((f) => ({ ...f, prompt: s.prompt, cron: s.cron }));
        notify(`Suggested: ${s.when}`);
      }, (err: Error) => notify(err.message, true))
      .finally(() => setSuggesting(false));
  }

  const alive = health && health.lastBeatAgoSec < 60;
  const active = jobs?.filter((j) => j.enabled).length ?? 0;
  const failing = jobs?.filter((j) => j.enabled && j.lastStatus === "failed").length ?? 0;

  return (
    <>
      <header className="page-head">
        <div>
          <h1>Schedules</h1>
          <p className="sub">Recurring prompts the agent runs on its own — describe one in plain language, or use /schedule in a thread.</p>
        </div>
        <button className="btn primary" onClick={() => setOpen(!open)}>
          New job
        </button>
      </header>

      <section className="card alive" aria-label="Keep-alive">
        <div className="alive-main">
          <div className="alive-title">
            <span className={`status-dot ${alive ? "ok" : "bad"}`} aria-hidden="true" />
            <h2>{health ? (alive ? "Bridge is alive" : "No heartbeat") : "Checking…"}</h2>
          </div>
          <p className="muted">
            {health?.supervised
              ? "Supervised by systemd: if the process exits or crashes, it is restarted in 5 s."
              : "Not supervised. Install the systemd unit in scripts/switchboard.service so a crash restarts it automatically."}{" "}
            Stuck agent turns are killed at the turn timeout.
          </p>
        </div>
        {health && (
          <div className="alive-stats">
            <div>
              <small>Uptime</small>
              <strong>{duration(health.uptimeSec)}</strong>
            </div>
            <div>
              <small>Starts</small>
              <strong>{health.starts}</strong>
            </div>
            <div>
              <small>Crashes recovered</small>
              <strong className={health.crashes ? "warn" : ""}>{health.crashes}</strong>
            </div>
            <div>
              <small>Last heartbeat</small>
              <strong>{health.lastBeatAgoSec} s ago</strong>
            </div>
          </div>
        )}
      </section>

      {!open && (
        <section className="card schedule-recipes" aria-label="Recipes">
          <div className="card-title">
            <h2>Recipes</h2>
            <p className="muted small">Starting points with a real prompt — tweak cron/repo, then create.</p>
          </div>
          <div className="recipe-grid">
            {RECIPES.map((r) => (
              <button key={r.id} type="button" className="recipe" onClick={() => applyRecipe(r.id)}>
                <strong>{r.label}</strong>
                <span className="muted small">{r.blurb}</span>
              </button>
            ))}
          </div>
        </section>
      )}

      {open && (
        <form
          className="card form"
          onSubmit={(e) => {
            e.preventDefault();
            const job = {
              prompt: form.prompt,
              cron: form.trigger === "cron" ? form.cron : "",
              space: form.space,
              trigger: form.trigger,
              needsApproval: form.needsApproval,
              ...(form.repo && { repo: form.repo }),
              ...(form.trigger === "command" && { command: form.command }),
              ...(form.trigger === "mention" && { pattern: form.pattern }),
            };
            void act(api.addSchedule(job), "Job created").then(() => {
              setOpen(false);
              setAiDraft("");
              setForm({ ...form, prompt: "" });
            });
          }}
        >
          <h2>New job</h2>
          <div className="field">
            <span>Recipe</span>
            <div className="chips">
              {RECIPES.map((r) => (
                <button
                  key={r.id}
                  type="button"
                  className={`chip ${form.prompt === r.prompt && form.cron === r.cron ? "on" : ""}`}
                  aria-pressed={form.prompt === r.prompt && form.cron === r.cron}
                  onClick={() => applyRecipe(r.id)}
                >
                  {r.label}
                </button>
              ))}
            </div>
          </div>
          <div className="field">
            <div className="field-head">
              <span>Describe with AI</span>
              <button type="button" className="btn small" disabled={!aiDraft.trim() || suggesting} onClick={fillWithAi}>
                {suggesting ? "Asking…" : "Fill with AI"}
              </button>
            </div>
            <textarea
              rows={2}
              value={aiDraft}
              onChange={(e) => setAiDraft(e.target.value)}
              placeholder="Every weekday at 9, summarize yesterday's commits and list open PRs."
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  fillWithAi();
                }
              }}
            />
            <span className="muted small">Plain language → the agent fills prompt and cron. Review below, then create.</span>
          </div>
          <label className="field">
            <span>What should the agent do?</span>
            <textarea rows={2} required value={form.prompt} onChange={(e) => setForm({ ...form, prompt: e.target.value })} placeholder="Summarize yesterday's commits on dev and list open questions." />
          </label>
          <fieldset className="field">
            <legend>Runs</legend>
            <div className="chips">
              {TRIGGERS.map((t) => (
                <button key={t.value} type="button" className={`chip ${form.trigger === t.value ? "on" : ""}`} aria-pressed={form.trigger === t.value} onClick={() => setForm({ ...form, trigger: t.value, space: t.value === "cron" ? form.space : TEAM_ONLY })}>
                  {t.label}
                </button>
              ))}
            </div>
            {form.trigger === "command" && (
              <label className="inline">
                <span className="muted small">Command, without the slash</span>
                <input className="mono" value={form.command} onChange={(e) => setForm({ ...form, command: e.target.value })} placeholder="ship" required />
              </label>
            )}
            {form.trigger === "mention" && (
              <label className="inline">
                <span className="muted small">Runs when a message contains this text</span>
                <input value={form.pattern} onChange={(e) => setForm({ ...form, pattern: e.target.value })} placeholder="deploy now" required />
              </label>
            )}
          </fieldset>
          {form.trigger === "cron" && (
          <fieldset className="field">
            <legend>When</legend>
            <div className="chips">
              {PRESETS.map((p) => (
                <button key={p.cron} type="button" className={`chip ${form.cron === p.cron ? "on" : ""}`} aria-pressed={form.cron === p.cron} onClick={() => setForm({ ...form, cron: p.cron })}>
                  {p.label}
                </button>
              ))}
            </div>
            <label className="inline">
              <span className="muted small">Cron (minute hour day month weekday)</span>
              <input className="mono" value={form.cron} onChange={(e) => setForm({ ...form, cron: e.target.value })} required />
            </label>
          </fieldset>
          )}
          <label className="inline check">
            <input type="checkbox" checked={form.needsApproval} onChange={(e) => setForm({ ...form, needsApproval: e.target.checked })} />
            <span>Ask for approval before each run</span>
          </label>
          <div className="grid-2">
            <label className="field">
              <span>{form.trigger === "cron" ? "Post results to" : "Listens in"}</span>
              <select value={form.space} onChange={(e) => setForm({ ...form, space: e.target.value })} required>
                <option value={TEAM_ONLY}>{form.trigger === "cron" ? "Only this app (job log)" : "Team chat rooms"}</option>
                {settings.allowedSpaces.map((s) => (
                  <option key={s} value={s}>
                    Google Chat · {s}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>Work in</span>
              <select value={form.repo} onChange={(e) => setForm({ ...form, repo: e.target.value })}>
                <option value="">No repo (chat only)</option>
                {Object.entries(settings.repos).map(([name, r]) => (
                  <option key={name} value={name}>
                    {name}
                    {r.base ? ` · from ${r.base}` : ""}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="form-actions">
            <button type="button" className="btn" onClick={() => setOpen(false)}>
              Cancel
            </button>
            <button className="btn primary">Create job</button>
          </div>
        </form>
      )}

      <section className="card flush">
        <div className="card-head">
          <h2>Jobs</h2>
          <span className="muted">
            {active} active{failing ? ` · ${failing} failing` : ""}
          </span>
        </div>
        {jobs && jobs.length === 0 && (
          <p className="empty">
            No jobs yet. Pick a recipe above, or create one — also in any thread:{" "}
            <code>/schedule 0 9 * * 1-5 Summarize the standup</code>
          </p>
        )}
        {jobs?.map((j) => {
          const s = status(j);
          const showingLog = logId === j.id;
          return (
            <div key={j.id} className="job-block">
              <div className="job">
                <div className="job-main">
                  <div className="job-title">
                    <span className="strong">{j.name}</span>
                    <span className={`pill ${s.tone}`}>{s.label}</span>
                  </div>
                  <div>
                    {j.trigger === "command" ? (
                      <>When someone writes <code>/{j.command}</code></>
                    ) : j.trigger === "mention" ? (
                      <>When a message contains “{j.pattern}”</>
                    ) : (
                      <>
                        {j.when} <code className="muted">{j.cron}</code>
                      </>
                    )}
                    {j.needsApproval && <span className="pill"> needs approval</span>}
                  </div>
                  {j.pending && (
                    <div className="approval">
                      <span className="small">Waiting for approval ({j.pending.reason})</span>
                      <button type="button" className="btn small primary" onClick={() => void act(api.decideApproval(j.pending!.id, true).then(api.schedules), "Approved")}>
                        Approve
                      </button>
                      <button type="button" className="btn small" onClick={() => void act(api.decideApproval(j.pending!.id, false).then(api.schedules), "Denied")}>
                        Deny
                      </button>
                    </div>
                  )}
                  <div className="muted small">
                    {j.createdBy === "control plane" ? "Created here" : `Created by ${j.createdBy}`} · {j.space.startsWith("spaces/") ? j.space : "this app only"}
                    {j.repo ? ` · ${j.repo}` : ""}
                  </div>
                </div>
                <div className="job-times small">
                  <span>Last: {ago(j.lastRunAt)}</span>
                  <span>Next: {j.enabled ? until(j.nextRunAt) : "paused"}</span>
                </div>
                <div className="job-actions">
                  <button className="btn" onClick={() => setLogId(showingLog ? undefined : j.id)} aria-pressed={showingLog}>
                    {showingLog ? "Hide log" : "Log"}
                  </button>
                  <button className="btn" onClick={() => void act(api.runSchedule(j.id), "Running")} disabled={j.lastStatus === "running"}>
                    Run now
                  </button>
                  <button
                    className={`switch ${j.enabled ? "on" : ""}`}
                    role="switch"
                    aria-checked={j.enabled}
                    aria-label={`Enable ${j.name}`}
                    onClick={() => void act(api.updateSchedule(j.id, { enabled: !j.enabled }), j.enabled ? "Paused" : "Resumed")}
                  >
                    <span />
                  </button>
                  <button
                    className="btn icon ghost"
                    aria-label={`Delete ${j.name}`}
                    onClick={() =>
                      void act(api.deleteSchedule(j.id), "Job deleted").then(() => {
                        if (logId === j.id) setLogId(undefined);
                      })
                    }
                  >
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                      <path d="M6 6l12 12M18 6L6 18" />
                    </svg>
                  </button>
                </div>
              </div>
              {showingLog && (
                <div className="job-log" aria-live="polite">
                  {logMessages === undefined && <p className="muted small">Loading…</p>}
                  {logMessages && logMessages.length === 0 && (
                    <p className="muted small">No runs recorded yet. Open Log after the next run — older runs before this feature are not kept.</p>
                  )}
                  {logMessages && logMessages.length > 0 && (
                    <ol className="job-log-list">
                      {logMessages.map((m, i) => (
                        <li key={`${m.at ?? i}-${i}`} className={m.bot ? "bot" : ""}>
                          <div className="job-log-meta">
                            <span className={`strong ${m.bot && m.author.startsWith("@") ? "agent-tint author" : ""}`} style={m.bot && m.author.startsWith("@") ? agentTint(m.author) : undefined}>
                              {m.bot && !m.author.startsWith("@") ? BOT_NAME : m.author}
                            </span>
                            <span className="muted">{ago(m.at)}</span>
                          </div>
                          <pre className="job-log-text">{m.text}</pre>
                        </li>
                      ))}
                    </ol>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </section>
    </>
  );
}
