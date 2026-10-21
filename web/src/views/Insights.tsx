import { useEffect, useMemo, useState } from "react";
import { api, type EngramDigest, type InsightsDigest, type InsightsFilter } from "../api";
import type { ViewProps } from "../App";
import { MessageMarkdown } from "../MessageMarkdown";
import { EvalsPanel } from "./Evals";

type Tab = "agents" | "evals" | "talk" | "engram";

const TABS: { id: Tab; label: string; blurb: string }[] = [
  { id: "agents", label: "Agents & tools", blurb: "System prompts, tools, models and cost, from the harness history." },
  { id: "evals", label: "Evals", blurb: "How well the harness answers: success, loops, latency and cost per agent, model or prompt, AI-judged quality and a fixed test suite." },
  { id: "talk", label: "Conversations", blurb: "What people ask the agents about, where they get stuck, and what could become a skill or schedule." },
  { id: "engram", label: "Memory", blurb: "Everything your agents saved in Engram: health of the memory and the lessons it holds." },
];

const RANGES = [1, 7, 30, 90] as const;

const PRESETS: Record<Tab, string[]> = {
  evals: ["Why answers fail", "Slowest agents", "Model to switch", "Cases to add to the suite"],
  agents: ["System prompts", "Tools that fail", "Cost and context size", "Model choice"],
  talk: ["Recurring questions", "Frustration", "Ideas for skills", "Ideas for schedules"],
  engram: ["Duplicates and noise", "Rules for AGENTS.md", "Recurring bugs", "Saving policy"],
};

const usd = (n: number) => (n >= 1 ? `$${n.toFixed(2)}` : `$${n.toFixed(4)}`);
const num = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(Math.round(n)));
const pct = (a: number, b: number) => (b > 0 ? `${Math.round((a / b) * 100)}%` : "—");

function readHash(): Tab {
  const t = location.hash.split("/")[1] as Tab;
  return TABS.some((x) => x.id === t) ? t : "agents";
}

function Stat({ label, value, hint, tone }: { label: string; value: string | number; hint?: string; tone?: "bad" | "ok" }) {
  return (
    <div className={`ins-stat ${tone ?? ""}`}>
      <span className="ins-stat-label">{label}</span>
      <strong>{value}</strong>
      {hint && <span className="ins-stat-hint">{hint}</span>}
    </div>
  );
}

function Bars<T>({ rows, value, label, extra, onPick }: { rows: T[]; value: (r: T) => number; label: (r: T) => string; extra?: (r: T) => React.ReactNode; onPick?: (r: T) => void }) {
  const max = Math.max(1, ...rows.map(value));
  if (rows.length === 0) return <p className="muted small">Nothing in this range.</p>;
  return (
    <ul className="ins-bars">
      {rows.map((r) => (
        <li key={label(r)}>
          {onPick ? (
            <button type="button" className="ins-bar-name link" onClick={() => onPick(r)} title={label(r)}>
              {label(r)}
            </button>
          ) : (
            <span className="ins-bar-name" title={label(r)}>
              {label(r)}
            </span>
          )}
          <span className="ins-bar-track">
            <span style={{ width: `${Math.max(3, (value(r) / max) * 100)}%` }} />
          </span>
          <span className="ins-bar-val">{num(value(r))}</span>
          {extra && <span className="ins-bar-extra">{extra(r)}</span>}
        </li>
      ))}
    </ul>
  );
}

function Select({ label, value, options, onChange }: { label: string; value: string; options: string[]; onChange: (v: string) => void }) {
  return (
    <label className="ins-select">
      <span>{label}</span>
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">All</option>
        {options.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    </label>
  );
}

export function InsightsView({ notify, settings }: ViewProps) {
  const [tab, setTabState] = useState<Tab>(readHash);
  const [days, setDays] = useState<number>(30);
  const [filter, setFilter] = useState<InsightsFilter>({});
  const [project, setProject] = useState("");
  const [data, setData] = useState<InsightsDigest>();
  const [engram, setEngram] = useState<EngramDigest>();
  const [error, setError] = useState<string>();
  const [focus, setFocus] = useState("");
  const [reports, setReports] = useState<Partial<Record<Tab, string>>>({});
  const [busy, setBusy] = useState<Tab | null>(null);

  const setTab = (t: Tab) => {
    setTabState(t);
    history.replaceState(null, "", `#insights/${t}`);
  };

  useEffect(() => {
    setError(undefined);
    api.insights(days, filter).then(setData, (e: Error) => setError(e.message));
  }, [days, filter]);
  useEffect(() => {
    api.engramInsights(project).then(setEngram, (e: Error) => setError(e.message));
  }, [project]);

  const analyze = () => {
    setBusy(tab);
    setError(undefined);
    const source = tab === "agents" || tab === "evals" ? "harness" : tab;
    api
      .analyzeInsights({ days, focus, source, project, ...filter })
      .then((r) => setReports((prev) => ({ ...prev, [tab]: r.report })), (e: Error) => setError(e.message))
      .finally(() => setBusy(null));
  };

  const t = data?.totals;
  const promptTok = t ? t.input + t.cacheRead : 0;
  const errors = useMemo(() => (data ? [...data.errorSamples, ...data.tools.flatMap((x) => x.sampleErrors.map((e) => `${x.name}: ${e}`))] : []), [data]);
  const et = engram?.totals;
  const pending = engram?.relations?.filter((r) => r.status === "pending").reduce((n, r) => n + r.n, 0) ?? 0;
  const active = TABS.find((x) => x.id === tab)!;
  const report = reports[tab];

  return (
    <div className="ins">
      <header className="ins-head">
        <div>
          <h1>Insights</h1>
          <p className="muted">{active.blurb}</p>
        </div>
        <nav className="ins-tabs" aria-label="Insights sections">
          {TABS.map((x) => (
            <button key={x.id} type="button" className={tab === x.id ? "on" : ""} aria-pressed={tab === x.id} onClick={() => setTab(x.id)}>
              {x.label}
            </button>
          ))}
        </nav>
      </header>

      <div className="ins-filters">
        {tab === "engram" ? (
          <Select label="Project" value={project} options={engram?.projects ?? []} onChange={setProject} />
        ) : (
          <>
            <div className="ins-range" role="group" aria-label="Range">
              {RANGES.map((d) => (
                <button key={d} type="button" className={days === d ? "on" : ""} aria-pressed={days === d} onClick={() => setDays(d)}>
                  {d === 1 ? "Today" : `${d}d`}
                </button>
              ))}
            </div>
            <Select label="Agent" value={filter.agent ?? ""} options={data?.options.agents ?? []} onChange={(v) => setFilter((f) => ({ ...f, agent: v || undefined }))} />
            <Select label="Repo" value={filter.repo ?? ""} options={data?.options.repos ?? []} onChange={(v) => setFilter((f) => ({ ...f, repo: v || undefined }))} />
            <Select label="Thread" value={filter.thread ?? ""} options={data?.options.threads ?? []} onChange={(v) => setFilter((f) => ({ ...f, thread: v || undefined }))} />
          </>
        )}
        {(filter.agent || filter.repo || filter.thread || project) && (
          <button
            type="button"
            className="btn small"
            onClick={() => {
              setFilter({});
              setProject("");
            }}
          >
            Clear filters
          </button>
        )}
      </div>

      {error && <p className="small mcp-error">{error}</p>}

      {tab === "agents" && t && data && (
        <>
          <div className="ins-stats">
            <Stat label="Model calls" value={t.turns} hint={usd(t.cost)} />
            <Stat label="Avg input per call" value={`${num(t.turns ? promptTok / t.turns : 0)} tok`} hint={`catalogue ${num(data.codemodeChars.max / 4)} tok`} />
            <Stat label="Cache reuse" value={pct(t.cacheRead, promptTok)} tone={promptTok && t.cacheRead / promptTok < 0.3 ? "bad" : undefined} />
            <Stat label="PASS replies" value={t.passes} hint={`${usd(t.passCost)} · ${pct(t.passCost, t.cost)} of cost`} />
            <Stat label="Tool calls" value={t.toolCalls} hint={`${pct(t.toolErrors, t.toolCalls)} failed`} tone={t.toolErrors ? "bad" : undefined} />
            <Stat label="Model errors" value={t.errors} tone={t.errors ? "bad" : "ok"} />
          </div>
          <div className="ins-grid">
            <section className="ins-panel">
              <h2>Tools</h2>
              <Bars
                rows={data.tools.slice(0, 14)}
                value={(x) => x.calls}
                label={(x) => x.name}
                extra={(x) => (
                  <>
                    {x.errors > 0 && <span className="pill bad" title={x.sampleErrors.join("\n\n")}>{x.errors} err</span>}
                    <span className="muted">{num(x.calls ? x.resultChars / x.calls / 4 : 0)} tok/result</span>
                  </>
                )}
              />
            </section>
            <section className="ins-panel">
              <h2>Agents</h2>
              <Bars
                rows={data.agents}
                value={(a) => a.turns}
                label={(a) => a.agent}
                onPick={(a) => setFilter((f) => ({ ...f, agent: a.agent }))}
                extra={(a) => (
                  <>
                    {a.passes > 0 && <span className="pill">{a.passes} PASS</span>}
                    <span className="muted">{usd(a.cost)}</span>
                  </>
                )}
              />
            </section>
            <section className="ins-panel">
              <h2>Models</h2>
              <Bars rows={data.models} value={(m) => m.calls} label={(m) => m.model} extra={(m) => <span className="muted">{usd(m.cost)}</span>} />
            </section>
            <section className="ins-panel">
              <h2>System prompts sent</h2>
              {data.prompts.length === 0 && <p className="muted small">None in this range.</p>}
              {data.prompts.map((p, i) => (
                <details key={i} className="ins-prompt">
                  <summary>
                    <span>{p.agents.join(", ")}</span>
                    <span className="muted small">
                      {num(p.chars / 4)} tok · {p.uses}×
                    </span>
                  </summary>
                  <pre>{p.text}</pre>
                </details>
              ))}
            </section>
          </div>
          {errors.length > 0 && (
            <details className="ins-panel ins-errors">
              <summary>
                <h2>Errors ({errors.length})</h2>
              </summary>
              <pre>{errors.join("\n\n")}</pre>
            </details>
          )}
        </>
      )}

      {tab === "evals" && <EvalsPanel data={data} days={days} filter={filter} agents={settings.personas.map((p) => p.name)} notify={notify} />}

      {tab === "talk" && data && (
        <section className="ins-panel">
          <h2>Recent conversations ({data.exchanges.length})</h2>
          {data.exchanges.length === 0 && <p className="muted small">Nothing in this range.</p>}
          <ul className="ins-talk">
            {data.exchanges.slice(0, 40).map((x, i) => (
              <li key={i}>
                <div className="ins-talk-meta">
                  <span className="pill">{x.agent}</span>
                  <span className="muted small" title={x.thread}>
                    {x.thread}
                  </span>
                  <span className="muted small">{x.at.slice(0, 16).replace("T", " ")}</span>
                </div>
                <p className="ins-talk-user">{x.user}</p>
                {x.tools.length > 0 && <p className="ins-talk-tools">{[...new Set(x.tools)].map((n) => <code key={n}>{n}</code>)}</p>}
                <p className="ins-talk-reply muted">{x.reply || "(no reply)"}</p>
              </li>
            ))}
          </ul>
        </section>
      )}

      {tab === "engram" && engram && !engram.available && <p className="muted">Engram is not installed or has no memory yet ({engram.path}).</p>}
      {tab === "engram" && et && engram && (
        <>
          <div className="ins-stats">
            <Stat label="Memories" value={et.observations} hint={`${et.last7d} this week · ${et.last30d} this month`} />
            <Stat label="Projects" value={engram.byProject?.length ?? 0} />
            <Stat label="Pending relations" value={pending} tone={pending > 20 ? "bad" : undefined} hint="conflicts never judged" />
            <Stat label="Repeated titles" value={engram.sameTitle?.length ?? 0} tone={(engram.sameTitle?.length ?? 0) > 5 ? "bad" : undefined} />
            <Stat label="Sessions w/o summary" value={`${et.sessionsNoSummary}/${et.sessions}`} tone={et.sessionsNoSummary ? "bad" : "ok"} />
            <Stat label="Pinned" value={et.pinned} hint={`${et.revised} revised`} />
          </div>
          <div className="ins-grid">
            <section className="ins-panel">
              <h2>By project</h2>
              <Bars rows={engram.byProject ?? []} value={(p) => p.n} label={(p) => p.project || "(none)"} onPick={(p) => setProject(p.project)} />
            </section>
            <section className="ins-panel">
              <h2>By type</h2>
              <Bars rows={engram.byType ?? []} value={(x) => x.n} label={(x) => x.type} />
            </section>
            {(engram.sameTitle?.length ?? 0) > 0 && (
              <section className="ins-panel">
                <h2>Repeated titles</h2>
                <Bars rows={engram.sameTitle ?? []} value={(x) => x.n} label={(x) => x.title} extra={(x) => <span className="muted small">#{x.ids.split(",").join(" #")}</span>} />
              </section>
            )}
          </div>
        </>
      )}

      <section className="ins-ask" aria-label="Ask the AI">
        <div className="ins-ask-head">
          <h2>Ask the AI</h2>
          <span className="muted small">
            Runs on demand on what is shown above{tab === "engram" ? (project ? ` (project ${project})` : " (all of Engram)") : ` (${days === 1 ? "today" : `${days} days`}${filter.agent ? `, ${filter.agent}` : ""}${filter.repo ? `, ${filter.repo}` : ""})`}.
          </span>
        </div>
        <div className="chips">
          {PRESETS[tab].map((p) => (
            <button key={p} type="button" className={`chip ${focus === p ? "on" : ""}`} aria-pressed={focus === p} onClick={() => setFocus(focus === p ? "" : p)}>
              {p}
            </button>
          ))}
        </div>
        <form
          className="row"
          onSubmit={(e) => {
            e.preventDefault();
            analyze();
          }}
        >
          <input className="grow" value={focus} onChange={(e) => setFocus(e.target.value)} placeholder="Optional focus, or pick one above" aria-label="Analysis focus" />
          <button className="btn primary" disabled={busy !== null}>
            {busy === tab ? "Analyzing…" : report ? "Analyze again" : "Analyze"}
          </button>
        </form>
        {busy === tab && <p className="muted small">Reading {tab === "engram" ? "every memory" : "the history"}; this takes up to a minute.</p>}
        {report && (
          <div className="ins-report">
            <div className="row">
              <span className="grow" />
              <button
                type="button"
                className="btn small"
                onClick={() => {
                  void navigator.clipboard.writeText(report);
                  notify("Report copied");
                }}
              >
                Copy
              </button>
            </div>
            <MessageMarkdown text={report} mediaUrl={(id) => `/api/media/${id}`} />
          </div>
        )}
      </section>
    </div>
  );
}
