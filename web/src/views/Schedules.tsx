import { useEffect, useRef, useState } from "react";
import { agentTint, BOT_NAME } from "../agent-color";
import { ago, api, duration, until, type Health, type Job, type JobTrigger, type ScheduleLogMessage } from "../api";
import { hashQuery, type ViewProps } from "../App";
import { CodeEditor } from "../CodeEditor";
import { jobAlertsOn, setJobAlerts } from "../jobAlerts";

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
  {
    id: "sentry-digest",
    label: "Sentry digest",
    blurb: "Weekday AM: new and spiking errors from the last 24 h (needs the Sentry MCP).",
    cron: "0 9 * * 1-5",
    prompt: [
      "Use the sentry__ tools. If they are missing, reply only: \"Add Sentry in Settings › Tools › MCP catalog\".",
      "1) List issues first seen or regressed in the last 24 hours, and the top 5 by event count.",
      "2) For each: title, project, events and users affected, first/last seen, link.",
      "3) Flag anything that started right after a release.",
      "Reply in 3 short sections: New / Spiking / Probably noise. Max ~15 lines. Do not invent issues.",
    ].join("\n"),
  },
  {
    id: "grafana-digest",
    label: "Grafana alerts",
    blurb: "Weekday AM: alerts that fired overnight and dashboards worth a look (needs the Grafana MCP).",
    cron: "0 8 * * 1-5",
    prompt: [
      "Use the grafana__ tools, read-only. If they are missing, reply only: \"Add Grafana in Settings › Tools › MCP catalog\".",
      "1) List alert rules that are firing or fired in the last 24 hours, with state and since when.",
      "2) For the worst two, query the related panel or datasource for the last 24 h and describe the shape (spike, step, slow climb).",
      "3) Note any incidents or annotations in that window.",
      "Reply: Firing now / Resolved overnight / Worth a look. Max ~15 lines, links to the dashboards.",
    ].join("\n"),
  },
  {
    id: "pr-summary",
    label: "PR summary",
    blurb: "Mondays: open PRs, who is waiting on whom, and what is stale (GitHub MCP or gh).",
    cron: "0 9 * * 1",
    preferRepo: true,
    prompt: [
      "Summarize open pull requests for this repo. Use the github__ tools if present, otherwise `gh pr list --state open --json number,title,author,reviewDecision,updatedAt,isDraft,url`.",
      "Group into: Ready to merge / Waiting on review / Waiting on author / Drafts / Stale (no update in 7+ days).",
      "One line each: #number title — author, age, link. End with the one PR that most needs attention and why.",
      "Do not invent PRs; if neither GitHub source works, say which one to set up.",
    ].join("\n"),
  },
  {
    id: "deps-audit",
    label: "Dependency audit",
    blurb: "Mondays: known vulnerabilities and major updates in this repo's dependencies.",
    cron: "0 8 * * 1",
    preferRepo: true,
    prompt: [
      "Audit dependencies in this worktree with the tools available: npm audit --json, cargo audit, pip-audit, dotnet list package --vulnerable, whichever apply.",
      "List high and critical findings with package, installed and fixed version, and advisory link. Then up to 5 major-version updates worth planning.",
      "Do not change any files. Reply in two sections: Fix now / Plan. If nothing applies, say so in one line.",
    ].join("\n"),
  },
  {
    id: "tech-brief",
    label: "Tech brief",
    blurb: "Weekday AM: news about the tools and vendors you use, with sources (Exa search).",
    cron: "0 8 * * 1-5",
    prompt: [
      "Search the web (exa__ tools) for news from the last 24 hours about: <edit this list: e.g. Rust, React, Azure, OpenAI, Anthropic>.",
      "Keep only releases, breaking changes, security advisories, pricing changes and outages.",
      "Reply with up to 8 bullets: what happened, why it matters to us, link. Skip anything you cannot source.",
    ].join("\n"),
  },
];

function status(job: Job): { label: string; tone: string } {
  if (!job.enabled) return { label: "Paused", tone: "" };
  if (job.lastStatus === "running") return { label: "Running", tone: "info" };
  if (job.lastStatus === "failed") return { label: job.failures ? `Failed · retry ${job.failures} of 3` : "Failed", tone: "bad" };
  if (job.lastStatus === "ok") return { label: "Succeeded", tone: "ok" };
  if (job.lastStatus === "idle") return { label: "Nothing to do", tone: "" };
  if (job.pending) return { label: "Waiting for approval", tone: "warn" };
  if (job.lastStatus === "denied") return { label: "Denied", tone: "" };
  return { label: job.trigger === "cron" ? "Scheduled" : "Listening", tone: "accent" };
}

function promptSummary(prompt: string): string {
  const first = prompt.split(/\n/).find((l) => l.trim()) ?? "";
  return first.length > 140 ? `${first.slice(0, 140)}…` : first;
}

function JobFlow(props: { when: string; precheck?: string; needsApproval: boolean; prompt: string; space: string; repo?: string; webhook?: string }) {
  const steps = [
    props.when,
    ...(props.precheck ? [`Runs its precheck script (${props.precheck.split("\n").length} lines) — stops here if it prints nothing`] : []),
    ...(props.needsApproval ? ["Waits for your approval"] : []),
    `Agent${props.repo ? ` in ${props.repo}` : ""}: ${promptSummary(props.prompt) || "—"}`,
    `Notifies the Notifications chat${props.space.startsWith("spaces/") ? ` and ${props.space}` : ""}`,
    ...(props.webhook ? [`Sends it to the webhook ${props.webhook.replace(/^https?:\/\//, "").split("/")[0]}`] : []),
  ];
  return (
    <ol className="job-flow small">
      {steps.map((step, i) => (
        <li key={i}>{step}</li>
      ))}
    </ol>
  );
}

/** Not a Chat space: the run is only recorded in the job log (see schedule-run.ts). */
const TEAM_ONLY = "team-chat";

export function Schedules({ settings, notify }: ViewProps) {
  const [jobs, setJobs] = useState<Job[]>();
  const [health, setHealth] = useState<Health>();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Job>();
  const [suggesting, setSuggesting] = useState(false);
  const [aiDraft, setAiDraft] = useState("");
  const [form, setForm] = useState({
    name: "",
    prompt: "",
    cron: PRESETS[1]!.cron,
    space: settings.allowedSpaces[0] ?? TEAM_ONLY,
    repo: "",
    trigger: "cron" as JobTrigger,
    command: "",
    pattern: "",
    needsApproval: false,
    precheck: "",
    webhook: "",
    notifyFailures: true,
  });
  const [alerts, setAlerts] = useState(jobAlertsOn);
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

  const exportJobs = (only?: Job) => {
    const portable = (only ? [only] : jobs ?? []).map((j) => ({
      name: j.name,
      prompt: j.prompt,
      cron: j.cron,
      trigger: j.trigger,
      space: j.space,
      ...(j.repo && { repo: j.repo }),
      ...(j.command && { command: j.command }),
      ...(j.pattern && { pattern: j.pattern }),
      ...(j.precheck && { precheck: j.precheck }),
      ...(j.webhook && { webhook: j.webhook }),
      notifyFailures: j.notifyFailures ?? true,
      needsApproval: j.needsApproval,
    }));
    const url = URL.createObjectURL(new Blob([JSON.stringify({ version: 1, jobs: portable }, null, 2)], { type: "application/json" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = only ? `job-${only.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || only.id}.json` : "switchboard-jobs.json";
    a.click();
    URL.revokeObjectURL(url);
  };

  const importJobs = async (file: File) => {
    let list: Partial<Job>[];
    try {
      const data = JSON.parse(await file.text());
      list = Array.isArray(data) ? data : data.jobs;
      if (!Array.isArray(list)) throw new Error("no jobs in file");
    } catch (err) {
      notify(`Import failed: ${(err as Error).message}`, true);
      return;
    }
    let added = 0;
    const failed: string[] = [];
    for (const j of list) {
      if (!j.prompt) continue;
      const space = j.space && (j.space === TEAM_ONLY || settings.allowedSpaces.includes(j.space)) ? j.space : TEAM_ONLY;
      try {
        setJobs(await api.addSchedule({
          name: j.name,
          prompt: j.prompt,
          cron: j.cron ?? "",
          space,
          trigger: j.trigger,
          needsApproval: j.needsApproval ?? false,
          ...(j.repo && settings.repos[j.repo] && { repo: j.repo }),
          ...(j.command && { command: j.command }),
          ...(j.pattern && { pattern: j.pattern }),
          ...(j.precheck && { precheck: j.precheck }),
          ...(j.webhook && { webhook: j.webhook }),
          notifyFailures: j.notifyFailures ?? true,
        }));
        added++;
      } catch (err) {
        failed.push(`${j.name ?? "job"}: ${(err as Error).message}`);
      }
    }
    notify(failed.length ? `Imported ${added}, failed ${failed.length} — ${failed.join("; ")}` : `Imported ${added} job${added === 1 ? "" : "s"}`, failed.length > 0);
  };

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
        <div className="head-actions">
        <button
          className="btn"
          aria-pressed={alerts}
          onClick={() => void setJobAlerts(!alerts).then((on) => {
            setAlerts(on);
            if (!alerts && !on) notify("The browser blocked notifications for this site", true);
          })}
        >
          {alerts ? "Desktop alerts on" : "Desktop alerts"}
        </button>
        <button className="btn" onClick={() => exportJobs()} disabled={!jobs?.length}>
          Export
        </button>
        <label className="btn">
          Import
          <input type="file" accept="application/json,.json" hidden onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) void importJobs(f); }} />
        </label>
        <button className="btn primary" onClick={() => { setEditing(undefined); if (!open) setForm((f) => ({ ...f, name: "", prompt: "" })); setOpen(!open); }}>
          New schedule
        </button>
        </div>
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
            if (!form.prompt.trim()) {
              notify("Describe what the agent should do", true);
              return;
            }
            if (editing) {
              const cronChanged = editing.trigger === "cron" && form.cron !== editing.cron;
              void act(api.updateSchedule(editing.id, {
                ...(form.name.trim() && { name: form.name.trim() }),
                prompt: form.prompt,
                precheck: form.precheck,
                webhook: form.webhook,
                notifyFailures: form.notifyFailures,
                ...(form.space !== editing.space && { space: form.space }),
                ...(cronChanged && { cron: form.cron }),
              }), "Job updated").then(() => {
                setOpen(false);
                setEditing(undefined);
              });
              return;
            }
            const job = {
              prompt: form.prompt,
              cron: form.trigger === "cron" ? form.cron : "",
              space: form.space,
              trigger: form.trigger,
              needsApproval: form.needsApproval,
              ...(form.precheck.trim() && { precheck: form.precheck.trim() }),
              ...(form.webhook.trim() && { webhook: form.webhook.trim() }),
              notifyFailures: form.notifyFailures,
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
          <h2>{editing ? "Edit schedule" : "New schedule"}</h2>
          {!editing && (
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
          )}
          {!editing && (
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
          )}
          {editing && (
            <label className="field">
              <span>Name</span>
              <input className="mono" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder={editing.name} />
            </label>
          )}
          <div className="field">
            <span>What should the agent do?</span>
            <CodeEditor
              value={form.prompt}
              onChange={(prompt) => setForm((f) => ({ ...f, prompt }))}
              language="markdown"
              minHeight={120}
              ariaLabel="What should the agent do?"
              placeholder="Summarize yesterday's commits on dev and list open questions."
            />
          </div>
          {!editing && (
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
          )}
          {editing && (
            <div className="field">
              <span>Runs</span>
              <div className="muted small">
                {editing.trigger === "command" ? <>When someone writes <code>/{editing.command}</code></>
                : editing.trigger === "mention" ? <>When a message contains “{editing.pattern}”</>
                : <>On a schedule</>}
              </div>
            </div>
          )}
          {(editing ? editing.trigger === "cron" : form.trigger === "cron") && (
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
          <div className="field">
            <span>Precheck script (Node.js, optional)</span>
            <CodeEditor
              value={form.precheck}
              onChange={(precheck) => setForm((f) => ({ ...f, precheck }))}
              language="javascript"
              minHeight={80}
              ariaLabel="Precheck script"
              placeholder={'const res = await fetch("https://…");\nconsole.log(JSON.stringify(await res.json()));'}
            />
            <span className="muted small">Saved inside the job and run with node before each run. Printing nothing skips the run for free; anything printed is appended to the prompt.</span>
          </div>
          <fieldset className="field">
            <legend>Notifications</legend>
            <label className="field">
              <span className="muted small">Webhook URL (Slack, Teams, Discord, Power Automate…) — optional</span>
              <input
                className="mono"
                type="url"
                value={form.webhook}
                placeholder="https://hooks.slack.com/services/…"
                onChange={(e) => setForm({ ...form, webhook: e.target.value })}
              />
            </label>
            <label className="inline check">
              <input type="checkbox" checked={form.notifyFailures} onChange={(e) => setForm({ ...form, notifyFailures: e.target.checked })} />
              <span>Also notify when a run fails</span>
            </label>
            <span className="muted small">Results always land in the Notifications chat (Team chat), plus the Chat space below and the webhook if set. Runs where the precheck found nothing never notify.</span>
          </fieldset>
          {!editing && (
          <>
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
          </>
          )}
          {editing && (
            <label className="field">
              <span>{editing.trigger === "cron" ? "Notify results in" : "Listens in"}</span>
              <select value={form.space} onChange={(e) => setForm({ ...form, space: e.target.value })}>
                <option value={TEAM_ONLY}>{editing.trigger === "cron" ? "Only this app (job log)" : "Team chat rooms"}</option>
                {[...new Set([...settings.allowedSpaces, ...(editing.space !== TEAM_ONLY ? [editing.space] : [])])].map((s) => (
                  <option key={s} value={s}>
                    Google Chat · {s}
                  </option>
                ))}
              </select>
            </label>
          )}
          {editing && (editing.repo || editing.needsApproval) && (
            <div className="field muted small">
              <span>Fixed</span>
              {[editing.repo && `repo ${editing.repo}`, editing.needsApproval && "asks for approval"].filter(Boolean).join(" · ")} — delete and re-create to change these.
            </div>
          )}
          <div className="field">
            <span>How it runs</span>
            <JobFlow
              when={form.trigger === "command" ? `When someone writes /${form.command}` : form.trigger === "mention" ? `When a message contains “${form.pattern}”` : `On cron ${form.cron}`}
              precheck={form.precheck.trim() || undefined}
              needsApproval={editing ? editing.needsApproval : form.needsApproval}
              prompt={form.prompt}
              space={form.space}
              repo={editing ? editing.repo : form.repo || undefined}
              webhook={/^https?:\/\//.test(form.webhook) ? form.webhook : undefined}
            />
          </div>
          <div className="form-actions">
            <button type="button" className="btn" onClick={() => { setEditing(undefined); setOpen(false); }}>
              Cancel
            </button>
            <button className="btn primary">{editing ? "Save changes" : "Create job"}</button>
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
                  <JobFlow
                    when={j.trigger === "command" ? `When someone writes /${j.command}` : j.trigger === "mention" ? `When a message contains “${j.pattern}”` : j.when}
                    precheck={j.precheck}
                    needsApproval={j.needsApproval}
                    prompt={j.prompt}
                    space={j.space}
                    repo={j.repo}
                    webhook={j.webhook}
                  />
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
                  <button
                    className="btn"
                    aria-label={`Edit ${j.name}`}
                    onClick={() => {
                      setEditing(j);
                      setForm((f) => ({ ...f, name: j.name, prompt: j.prompt, precheck: j.precheck ?? "", webhook: j.webhook ?? "", notifyFailures: j.notifyFailures ?? true, space: j.space, cron: j.cron || PRESETS[1]!.cron }));
                      setOpen(true);
                    }}
                  >
                    Edit
                  </button>
                  <button className="btn" aria-label={`Export ${j.name}`} onClick={() => exportJobs(j)}>
                    Export
                  </button>
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
