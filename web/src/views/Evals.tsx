import { useEffect, useMemo, useState } from "react";
import { api, type AgentVersion, type EvalCase, type EvalRun, type InsightsDigest, type InsightsFilter, type Judgment, type ScoreRow } from "../api";

type Group = "agent" | "model" | "version" | "harness";

const GROUPS: { id: Group; label: string }[] = [
  { id: "agent", label: "Agent" },
  { id: "model", label: "Model" },
  { id: "version", label: "Agent version" },
  { id: "harness", label: "Harness" },
];

const usd = (n: number) => (n >= 1 ? `$${n.toFixed(2)}` : `$${n.toFixed(4)}`);
const secs = (ms: number) => (ms ? `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s` : "—");
const rate = (a: number, b: number) => (b > 0 ? a / b : 0);
const pct = (x: number) => `${Math.round(x * 100)}%`;
const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const judgeAvg = (j: Judgment) => (j.resolved + j.instructions + j.tools + j.concise) / 4;
const BEFORE = "before tracking";

function versionAt(versions: AgentVersion[], agent: string, at: string) {
  const who = (agent === "schedule" ? "host" : agent).toLowerCase();
  const t = Date.parse(at);
  let found: AgentVersion | undefined;
  for (const v of versions) if (v.agent.toLowerCase() === who && Date.parse(v.at) <= t) found = v;
  return found;
}

function groupKey(g: Group, j: Judgment, versions: AgentVersion[]) {
  if (g === "agent") return j.agent;
  if (g === "model") return j.model || "?";
  const v = versionAt(versions, j.agent, j.at);
  return g === "version" ? `${j.agent} · ${v?.id ?? BEFORE}` : (v?.harness ?? BEFORE);
}

function changes(prev: AgentVersion | undefined, v: AgentVersion) {
  if (!prev) return ["first seen"];
  const out: string[] = [];
  if (prev.harness !== v.harness) out.push(`harness ${prev.harness} → ${v.harness}`);
  if (prev.model !== v.model) out.push(`model ${prev.model} → ${v.model}`);
  if (prev.prompt !== v.prompt) out.push(`prompt ${prev.prompt.length} → ${v.prompt.length} chars`);
  const before = new Map(prev.skills.map((x) => [x.name, x.hash]));
  const after = new Map(v.skills.map((x) => [x.name, x.hash]));
  for (const [n, h] of after) {
    if (!before.has(n)) out.push(`+ skill ${n}`);
    else if (before.get(n) !== h) out.push(`skill ${n} edited`);
  }
  for (const n of before.keys()) if (!after.has(n)) out.push(`− skill ${n}`);
  for (const m of v.mcps) if (!prev.mcps.includes(m)) out.push(`+ tool ${m}`);
  for (const m of prev.mcps) if (!v.mcps.includes(m)) out.push(`− tool ${m}`);
  return out;
}

function Versions({ versions }: { versions: AgentVersion[] }) {
  const agents = [...new Set(versions.map((v) => v.agent))];
  if (versions.length === 0) return <p className="muted small">No versions recorded yet.</p>;
  return (
    <div className="ev-versions">
      {agents.map((a) => {
        const mine = versions.filter((v) => v.agent === a).reverse();
        return (
          <details key={a} className="ev-details">
            <summary>
              <strong>{a}</strong> <code>{mine[0].id}</code> <span className="muted small">{mine.length} versions</span>
            </summary>
            <ol className="ev-vlist" reversed>
              {mine.map((v, i) => (
                <li key={v.id + v.at}>
                  <div className="row">
                    <code>{v.id}</code>
                    <span className="muted small">{v.at.slice(0, 16).replace("T", " ")}</span>
                    <span className="muted small mono">{v.harness}</span>
                  </div>
                  <ul className="ev-changes">
                    {changes(mine[i + 1], v).map((c) => (
                      <li key={c}>{c}</li>
                    ))}
                  </ul>
                  <details className="ev-details">
                    <summary className="small muted">
                      {v.model} · {v.skills.length} skills · {v.mcps.length ? v.mcps.join(", ") : "all tools"}
                    </summary>
                    <pre className="ev-reply">{v.prompt || "(no custom prompt)"}</pre>
                  </details>
                </li>
              ))}
            </ol>
          </details>
        );
      })}
    </div>
  );
}

function Tone({ value, good, bad, children }: { value: number; good: number; bad: number; children: React.ReactNode }) {
  const lowerBetter = bad > good;
  const tone = lowerBetter ? (value >= bad ? "bad" : value <= good ? "ok" : "") : value <= bad ? "bad" : value >= good ? "ok" : "";
  return <span className={`ev-cell ${tone}`}>{children}</span>;
}

function Scorecard({ rows, judgments, group, versions }: { rows: ScoreRow[]; judgments: Judgment[]; group: Group; versions: AgentVersion[] }) {
  const judged = useMemo(() => {
    const m = new Map<string, number[]>();
    for (const j of judgments) {
      const k = groupKey(group, j, versions);
      m.set(k, [...(m.get(k) ?? []), judgeAvg(j)]);
    }
    return m;
  }, [judgments, group, versions]);
  if (rows.length === 0) return <p className="muted small">No answered messages in this range.</p>;
  return (
    <div className="table-wrap">
      <table className="ev-table">
        <thead>
          <tr>
            <th>{GROUPS.find((g) => g.id === group)!.label}</th>
            <th title="User messages that got an answer">Msgs</th>
            <th title="Answered without model error or empty reply">Success</th>
            <th title={`Answers that took 8+ model calls`}>Loops</th>
            <th title="Tool calls that failed">Tool err</th>
            <th>Cost/msg</th>
            <th>p50</th>
            <th>p95</th>
            <th title="Average LLM-judge score (1-5)">Judge</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const j = judged.get(r.key) ?? [];
            return (
              <tr key={r.key}>
                <td className="ev-key" title={r.key}>
                  {r.key}
                </td>
                <td>{r.exchanges}</td>
                <td>
                  <Tone value={rate(r.ok, r.exchanges)} good={0.95} bad={0.8}>
                    {pct(rate(r.ok, r.exchanges))}
                  </Tone>
                  {(r.errors > 0 || r.empty > 0) && (
                    <span className="muted small">
                      {" "}
                      {r.errors > 0 && `${r.errors} err`}
                      {r.errors > 0 && r.empty > 0 && " · "}
                      {r.empty > 0 && `${r.empty} empty`}
                    </span>
                  )}
                </td>
                <td>
                  <Tone value={rate(r.loops, r.exchanges)} good={0.02} bad={0.1}>
                    {pct(rate(r.loops, r.exchanges))}
                  </Tone>
                </td>
                <td>
                  <Tone value={rate(r.toolErrors, r.toolCalls)} good={0.03} bad={0.15}>
                    {r.toolCalls ? pct(rate(r.toolErrors, r.toolCalls)) : "—"}
                  </Tone>
                </td>
                <td>{usd(rate(r.cost, r.exchanges))}</td>
                <td>{secs(r.p50ms)}</td>
                <td>
                  <Tone value={r.p95ms / 1000} good={30} bad={120}>
                    {secs(r.p95ms)}
                  </Tone>
                </td>
                <td>
                  {j.length ? (
                    <Tone value={avg(j)} good={4} bad={3}>
                      {avg(j).toFixed(1)} <span className="muted small">({j.length})</span>
                    </Tone>
                  ) : (
                    <span className="muted">—</span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function Judged({ judgments, exchanges }: { judgments: Judgment[]; exchanges: InsightsDigest["exchanges"] }) {
  const worst = [...judgments].sort((a, b) => judgeAvg(a) - judgeAvg(b)).slice(0, 12);
  const byId = new Map(exchanges.map((e) => [e.id, e]));
  const dims = (["resolved", "instructions", "tools", "concise"] as const).map((k) => ({ k, v: avg(judgments.map((j) => j[k])) }));
  if (judgments.length === 0) return <p className="muted small">Nothing judged yet in this range.</p>;
  return (
    <>
      <div className="ins-stats">
        {dims.map((d) => (
          <div key={d.k} className={`ins-stat ${d.v < 3 ? "bad" : d.v >= 4 ? "ok" : ""}`}>
            <span className="ins-stat-label">{d.k}</span>
            <strong>{d.v.toFixed(2)}</strong>
            <span className="ins-stat-hint">of 5 · {judgments.length} judged</span>
          </div>
        ))}
      </div>
      <h3 className="ev-sub">Lowest scored</h3>
      <ul className="ins-talk">
        {worst.map((j) => {
          const e = byId.get(j.id);
          return (
            <li key={j.id}>
              <div className="ins-talk-meta">
                <span className={`pill ${judgeAvg(j) < 3 ? "bad" : ""}`}>{judgeAvg(j).toFixed(1)}</span>
                <span className="pill">{j.agent}</span>
                <span className="muted small">{j.model}</span>
                <span className="muted small">{j.at.slice(0, 16).replace("T", " ")}</span>
              </div>
              <p className="ins-talk-user">{j.note}</p>
              {e && (
                <details className="ev-details">
                  <summary className="small muted">Exchange</summary>
                  <p className="small">{e.user}</p>
                  <p className="small muted">{e.reply || e.error || "(no reply)"}</p>
                </details>
              )}
            </li>
          );
        })}
      </ul>
    </>
  );
}

const blank = (): EvalCase => ({ id: "", name: "", agent: "", prompt: "", expect: {} });
const list = (s: string) =>
  s
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);

function CaseEditor({ c, agents, onChange, onRemove }: { c: EvalCase; agents: string[]; onChange: (c: EvalCase) => void; onRemove: () => void }) {
  const set = (p: Partial<EvalCase["expect"]>) => onChange({ ...c, expect: { ...c.expect, ...p } });
  const num = (v: string) => (v.trim() === "" ? undefined : Number(v));
  return (
    <li className="ev-case">
      <div className="row">
        <input className="grow" value={c.name} placeholder="Case name" aria-label="Case name" onChange={(e) => onChange({ ...c, name: e.target.value })} />
        <select value={c.agent} aria-label="Agent" onChange={(e) => onChange({ ...c, agent: e.target.value })}>
          <option value="">host</option>
          {agents.map((a) => (
            <option key={a} value={a}>
              @{a}
            </option>
          ))}
        </select>
        <button type="button" className="btn small ghost" onClick={onRemove}>
          Remove
        </button>
      </div>
      <textarea rows={2} value={c.prompt} placeholder="What the user writes" aria-label="Prompt" onChange={(e) => onChange({ ...c, prompt: e.target.value })} />
      <div className="ev-expect">
        <label className="field">
          <span className="small muted">Must contain (comma separated)</span>
          <input value={(c.expect.contains ?? []).join(", ")} onChange={(e) => set({ contains: list(e.target.value) })} />
        </label>
        <label className="field">
          <span className="small muted">Must not contain</span>
          <input value={(c.expect.notContains ?? []).join(", ")} onChange={(e) => set({ notContains: list(e.target.value) })} />
        </label>
        <label className="field">
          <span className="small muted">Max cost ($)</span>
          <input type="number" step="0.001" min="0" value={c.expect.maxCost ?? ""} onChange={(e) => set({ maxCost: num(e.target.value) })} />
        </label>
        <label className="field">
          <span className="small muted">Max seconds</span>
          <input type="number" min="0" value={c.expect.maxSeconds ?? ""} onChange={(e) => set({ maxSeconds: num(e.target.value) })} />
        </label>
      </div>
      <label className="field">
        <span className="small muted">Rubric for the judge (optional)</span>
        <textarea rows={2} value={c.expect.rubric ?? ""} placeholder="e.g. Answers in Spanish, names the failing pipeline and suggests one fix" onChange={(e) => set({ rubric: e.target.value || undefined })} />
      </label>
    </li>
  );
}

function RunSummary({ run }: { run: EvalRun }) {
  const passed = run.results.filter((r) => r.pass).length;
  const cost = run.results.reduce((a, r) => a + r.cost, 0);
  return (
    <>
      <strong className={passed === run.results.length && run.status === "done" ? "ok-text" : passed < run.results.length ? "warn-text" : ""}>
        {passed}/{run.total}
      </strong>
      <span className="muted small">
        {run.status === "running" ? `running ${run.results.length}/${run.total}` : usd(cost)} · {run.model ?? "default model"}
        {run.label ? ` · ${run.label}` : ""}
      </span>
    </>
  );
}

function RunHead({ run, other }: { run: EvalRun; other?: EvalRun }) {
  const diff = (k: string) => other && other.versions?.[k] !== run.versions?.[k];
  return (
    <th>
      {run.label ?? run.id} {run.model && <span className="muted small">{run.model}</span>}
      <div className="ev-runver small">
        <span className={other && other.harness !== run.harness ? "warn-text" : "muted"}>harness {run.harness || "?"}</span>
        {Object.entries(run.versions ?? {}).map(([agent, id]) => (
          <span key={agent} className={diff(agent) ? "warn-text" : "muted"}>
            {agent} {id}
          </span>
        ))}
      </div>
    </th>
  );
}

function Compare({ a, b }: { a: EvalRun; b?: EvalRun }) {
  const ids = [...new Set([...a.results.map((r) => r.id), ...(b?.results.map((r) => r.id) ?? [])])];
  const cell = (run: EvalRun | undefined, id: string) => {
    const r = run?.results.find((x) => x.id === id);
    if (!r) return <td className="muted">—</td>;
    return (
      <td>
        <details className="ev-details">
          <summary>
            <span className={`pill ${r.pass ? "ok" : "bad"}`}>{r.pass ? "pass" : "fail"}</span> <span className="muted small">
              {r.seconds.toFixed(1)}s · {usd(r.cost)}
              {r.score !== undefined ? ` · ${r.score}/5` : ""}
            </span>
          </summary>
          <ul className="ev-checks">
            {r.checks.map((c, i) => (
              <li key={i} className={c.pass ? "ok-text" : "warn-text"}>
                {c.pass ? "✓" : "✗"} {c.name}
                {c.detail ? <span className="muted"> — {c.detail}</span> : null}
              </li>
            ))}
          </ul>
          {r.error && <p className="small mcp-error">{r.error}</p>}
          <pre className="ev-reply">{r.reply || "(no reply)"}</pre>
        </details>
      </td>
    );
  };
  return (
    <div className="table-wrap">
      <table className="ev-table ev-compare">
        <thead>
          <tr>
            <th>Case</th>
            <RunHead run={a} other={b} />
            {b && <RunHead run={b} other={a} />}
          </tr>
        </thead>
        <tbody>
          {ids.map((id) => {
            const name = a.results.find((r) => r.id === id)?.name ?? b?.results.find((r) => r.id === id)?.name ?? id;
            return (
              <tr key={id}>
                <td className="ev-key">{name}</td>
                {cell(a, id)}
                {b && cell(b, id)}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export function EvalsPanel({ data, days, filter, agents, notify }: { data?: InsightsDigest; days: number; filter: InsightsFilter; agents: string[]; notify: (text: string, error?: boolean) => void }) {
  const [group, setGroup] = useState<Group>("agent");
  const [cases, setCases] = useState<EvalCase[]>([]);
  const [dirty, setDirty] = useState(false);
  const [runs, setRuns] = useState<EvalRun[]>([]);
  const [judgments, setJudgments] = useState<Judgment[]>([]);
  const [models, setModels] = useState<string[]>([]);
  const [model, setModel] = useState("");
  const [label, setLabel] = useState("");
  const [pick, setPick] = useState<string[]>([]);
  const [busy, setBusy] = useState<"judge" | "save" | "run" | null>(null);
  const [error, setError] = useState<string>();
  const [versions, setVersions] = useState<AgentVersion[]>([]);

  const load = () =>
    api.evals().then((r) => {
      setRuns(r.runs);
      setJudgments(r.judgments);
      return r;
    });

  useEffect(() => {
    load().then((r) => setCases(r.cases), (e: Error) => setError(e.message));
    api.models().then(setModels, () => setModels([]));
    api.versions().then((r) => setVersions(r.versions), () => setVersions([]));
  }, []);

  const running = runs.some((r) => r.status === "running");
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => void load(), 3000);
    return () => clearInterval(t);
  }, [running]);

  const since = Date.now() - days * 86_400_000;
  const inRange = useMemo(
    () => judgments.filter((j) => Date.parse(j.at) >= since && (!filter.agent || j.agent === filter.agent) && (!filter.thread || data?.exchanges.some((e) => e.id === j.id))),
    [judgments, since, filter, data],
  );

  const fail = (e: Error) => setError(e.message);
  const judge = () => {
    setBusy("judge");
    setError(undefined);
    api
      .judgeEvals({ days, n: 15, ...filter })
      .then((r) => {
        notify(`Judged ${r.judged} messages`);
        return load();
      }, fail)
      .finally(() => setBusy(null));
  };
  const save = () => {
    setBusy("save");
    setError(undefined);
    return api
      .saveEvalCases(cases)
      .then((r) => {
        setCases(r.cases);
        setDirty(false);
        notify("Cases saved");
      }, fail)
      .finally(() => setBusy(null));
  };
  const run = async () => {
    if (dirty) await save();
    setBusy("run");
    setError(undefined);
    api
      .runEvals({ model: model || undefined, label: label || undefined })
      .then((r) => {
        setRuns((prev) => [r.run, ...prev]);
        setPick([r.run.id, ...pick].slice(0, 2));
      }, fail)
      .finally(() => setBusy(null));
  };
  const edit = (i: number, c: EvalCase) => {
    setCases((prev) => prev.map((x, j) => (j === i ? c : x)));
    setDirty(true);
  };
  const toggle = (id: string) => setPick((p) => (p.includes(id) ? p.filter((x) => x !== id) : [id, ...p].slice(0, 2)));
  const picked = pick.map((id) => runs.find((r) => r.id === id)).filter((r): r is EvalRun => !!r);

  return (
    <>
      {error && <p className="small mcp-error">{error}</p>}

      <section className="ins-panel">
        <div className="ev-head">
          <h2>Scorecard</h2>
          <div className="ins-range" role="group" aria-label="Group by">
            {GROUPS.map((g) => (
              <button key={g.id} type="button" className={group === g.id ? "on" : ""} aria-pressed={group === g.id} onClick={() => setGroup(g.id)}>
                {g.label}
              </button>
            ))}
          </div>
        </div>
        <p className="muted small">Every answered message in the range, measured from the harness history. An agent version changes whenever its prompt, model, skills, tools or the harness code change.</p>
        <Scorecard rows={data?.scorecard?.[group] ?? []} judgments={inRange} group={group} versions={versions} />
      </section>

      <section className="ins-panel">
        <h2>Versions</h2>
        <p className="muted small">What changed between versions of each agent. Harness is the git commit, with +hash when there are uncommitted changes.</p>
        <Versions versions={versions} />
      </section>

      <section className="ins-panel">
        <div className="ev-head">
          <h2>LLM judge</h2>
          <button type="button" className="btn primary small" disabled={busy !== null} onClick={judge}>
            {busy === "judge" ? "Judging…" : "Judge 15 more"}
          </button>
        </div>
        <p className="muted small">An AI grades real answers on resolved, instructions, tools and concise (1-5). Scores are kept, so the trend shows up in the scorecard.</p>
        <Judged judgments={inRange} exchanges={data?.exchanges ?? []} />
      </section>

      <section className="ins-panel">
        <div className="ev-head">
          <h2>Test suite</h2>
          <div className="row">
            <button type="button" className="btn small" onClick={() => (setCases((p) => [...p, blank()]), setDirty(true))}>
              Add case
            </button>
            <button type="button" className="btn small" disabled={!dirty || busy !== null} onClick={() => void save()}>
              {busy === "save" ? "Saving…" : "Save"}
            </button>
          </div>
        </div>
        <p className="muted small">Fixed prompts run against your agents in a fresh thread each time. Run them after changing a prompt, a tool or a model, and compare two runs side by side.</p>
        {cases.length === 0 && <p className="muted small">No cases yet.</p>}
        <ul className="ev-cases">
          {cases.map((c, i) => (
            <CaseEditor
              key={c.id || `new-${i}`}
              c={c}
              agents={agents}
              onChange={(x) => edit(i, x)}
              onRemove={() => {
                setCases((p) => p.filter((_, j) => j !== i));
                setDirty(true);
              }}
            />
          ))}
        </ul>
        <div className="ev-run row">
          <label className="ins-select">
            <span>Model</span>
            <select value={model} onChange={(e) => setModel(e.target.value)}>
              <option value="">Each agent's own</option>
              {models.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </label>
          <label className="ins-select grow">
            <span>Label</span>
            <input value={label} placeholder="e.g. shorter host prompt" onChange={(e) => setLabel(e.target.value)} />
          </label>
          <button type="button" className="btn primary" disabled={busy !== null || cases.length === 0 || running} onClick={() => void run()}>
            {running ? "Running…" : busy === "run" ? "Starting…" : "Run suite"}
          </button>
        </div>

        {runs.length > 0 && (
          <>
            <h3 className="ev-sub">Runs · pick two to compare</h3>
            <ul className="ev-runs">
              {runs.map((r) => (
                <li key={r.id} className={pick.includes(r.id) ? "on" : ""}>
                  <label className="row">
                    <input type="checkbox" checked={pick.includes(r.id)} onChange={() => toggle(r.id)} />
                    <span className="mono small">{r.id}</span>
                    <RunSummary run={r} />
                  </label>
                  <button
                    type="button"
                    className="btn small ghost"
                    disabled={r.status === "running"}
                    onClick={() =>
                      api.deleteEvalRun(r.id).then(() => {
                        setRuns((p) => p.filter((x) => x.id !== r.id));
                        setPick((p) => p.filter((x) => x !== r.id));
                      }, fail)
                    }
                  >
                    Delete
                  </button>
                </li>
              ))}
            </ul>
            {picked[0] && <Compare a={picked[0]} b={picked[1]} />}
          </>
        )}
      </section>
    </>
  );
}
