import { useEffect, useState, type FocusEvent } from "react";
import { api, type AdoRepo, type AdoStatus, type Agent, type ContextFooter, type RepoConfig, type Settings } from "../api";
import type { ViewProps } from "../App";
import { GoogleChatCard } from "./GoogleChat";

const FOOTER_OPTIONS: { value: ContextFooter; label: string }[] = [
  { value: "every", label: "Every reply" },
  { value: "every5", label: "Every 5 replies" },
  { value: "above60", label: "Only above 60%" },
  { value: "never", label: "Never" },
];

export function SettingsView(props: ViewProps) {
  return (
    <>
      <header className="page-head">
        <div>
          <h1>Settings</h1>
          <p className="sub">Changes apply to the next turn. Nothing here needs a restart.</p>
        </div>
      </header>
      <GoogleChatCard {...props} />
      <AgentCard {...props} />
      <ContextCard {...props} />
      <ReposCard {...props} />
      <SpacesCard {...props} />
    </>
  );
}

function AgentCard({ settings, save }: ViewProps) {
  const [agents, setAgents] = useState<Agent[]>();
  const [models, setModels] = useState<string[]>([]);
  const driver = settings.agentDriver;
  const [model, setModel] = useState(settings.models[driver] ?? "");

  useEffect(() => {
    api.agents().then(setAgents, () => setAgents([]));
    api.models().then(setModels, () => {});
  }, []);
  useEffect(() => {
    setModel(settings.models[driver] ?? "");
  }, [settings.models, driver]);

  const others = agents?.filter((a) => a.installed && !a.supported) ?? [];

  return (
    <section className="card">
      <div className="card-title">
        <h2>Agent</h2>
        <p className="muted small">
          Detected on this machine{others.length ? `. Also installed, no driver yet: ${others.map((a) => a.name).join(", ")}` : ""}.
        </p>
      </div>
      {!agents && <p className="muted">Detecting…</p>}
      <div className="grid-2">
        {agents
          ?.filter((a) => a.supported)
          .map((a) => (
            <label key={a.id} className={`option ${driver === a.id ? "on" : ""} ${a.installed ? "" : "disabled"}`}>
              <input
                type="radio"
                name="driver"
                checked={driver === a.id}
                disabled={!a.installed}
                onChange={() => void save({ agentDriver: a.id as Settings["agentDriver"] }, `Using ${a.name}`)}
              />
              <span>
                <span className="strong">{a.name}</span> {a.installed && <code className="muted">{a.version}</code>}
                <span className={`small block ${a.ready ? "ok-text" : "warn-text"}`}>
                  {!a.installed ? "Not installed" : `${a.ready ? "Ready" : "Needs setup"} · ${a.detail ?? ""}`}
                </span>
              </span>
            </label>
          ))}
      </div>
      <form
        className="row"
        onSubmit={(e) => {
          e.preventDefault();
          const value = model.trim();
          void save({ models: { ...settings.models, [driver]: value || undefined } }, value ? `Default model: ${value}` : "Using the agent's default model");
        }}
      >
        <label className="field grow">
          <span>Default model</span>
          <input
            className="mono"
            list={driver === "opencode" ? "models" : undefined}
            value={model}
            onChange={(e) => setModel(e.target.value)}
            placeholder={driver === "opencode" ? `${models.length} models available — empty = default` : "e.g. claude-opus-5-5 — empty = default"}
          />
          <span className="muted small">Threads can override it with /model.</span>
        </label>
        <datalist id="models">
          {models.map((m) => (
            <option key={m} value={m} />
          ))}
        </datalist>
        <button className="btn primary">Save</button>
      </form>
    </section>
  );
}

function ContextCard({ settings, save }: ViewProps) {
  return (
    <section className="card">
      <div className="card-title">
        <h2>Context in Chat</h2>
        <p className="muted small">A footer under agent replies: model, repo and branch, and how full the session is. Claude reports exact usage; OpenCode is estimated (~).</p>
      </div>
      <fieldset className="chips">
        <legend className="sr-only">Show the context footer</legend>
        {FOOTER_OPTIONS.map((o) => (
          <label key={o.value} className={`chip ${settings.contextFooter === o.value ? "on" : ""}`}>
            <input type="radio" name="footer" checked={settings.contextFooter === o.value} onChange={() => void save({ contextFooter: o.value }, `Context footer: ${o.label.toLowerCase()}`)} />
            {o.label}
          </label>
        ))}
      </fieldset>
      <p className="sample mono">— glm-5.3-flash · yFlow@chat/flow-export · context 62% (79k/128k)</p>
      <label className="check">
        <input
          type="checkbox"
          checked={settings.autoCompactAt > 0}
          onChange={(e) => void save({ autoCompactAt: e.target.checked ? 85 : 0 }, e.target.checked ? "Auto-compact at 85%" : "Auto-compact off")}
        />
        <span>Compact automatically at 85% and say so in the thread</span>
      </label>
    </section>
  );
}

function shortPath(path: string): string {
  return path.split("/").slice(-2).join("/");
}

function RepoRow({ name, repo, onChange, onRemove }: { name: string; repo: RepoConfig; onChange: (r: RepoConfig) => void; onRemove: () => void }) {
  // Saves one field on blur, dropping it when emptied.
  const field = (key: "base" | "up") => ({
    defaultValue: repo[key] ?? "",
    onBlur: (e: FocusEvent<HTMLInputElement>) => {
      const value = e.target.value.trim();
      if (value === (repo[key] ?? "")) return;
      const { [key]: _old, ...rest } = repo;
      onChange(value ? { ...rest, [key]: value } : rest);
    },
  });
  return (
    <div className="repo">
      <div className="repo-name">
        <span className="strong">{name}</span>
        <code className="muted" title={repo.path}>
          {shortPath(repo.path)}
        </code>
      </div>
      <label className="field narrow">
        <span>Base branch</span>
        <input className="mono" {...field("base")} placeholder="HEAD" />
      </label>
      <label className="field grow">
        <span>Up command</span>
        <input className="mono" {...field("up")} placeholder="npm run dev -- --port {port}" />
      </label>
      <button className="btn icon ghost" onClick={onRemove} aria-label={`Remove ${name}`}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
          <path d="M6 6l12 12M18 6L6 18" />
        </svg>
      </button>
    </div>
  );
}

function ReposCard({ settings, save, setSettings, notify }: ViewProps) {
  const [ado, setAdo] = useState<AdoStatus>();
  const [projects, setProjects] = useState<string[]>([]);
  const [project, setProject] = useState("");
  const [repos, setRepos] = useState<AdoRepo[]>([]);
  const [repo, setRepo] = useState("");
  const [cloning, setCloning] = useState(false);

  useEffect(() => {
    api.adoStatus().then(
      (s) => {
        setAdo(s);
        if (!s.connected) return;
        api.adoProjects().then((list) => {
          setProjects(list.map((p) => p.name));
          // ado CLI profiles are case-insensitive ("ysocial" vs "ySocial").
          const match = list.find((p) => p.name.toLowerCase() === s.defaultProject?.toLowerCase());
          if (match) setProject(match.name);
        }, () => {});
      },
      () => setAdo({ connected: false }),
    );
  }, []);
  useEffect(() => {
    setRepos([]);
    setRepo("");
    if (project) api.adoRepos(project).then(setRepos, () => {});
  }, [project]);

  const entries = Object.entries(settings.repos);

  return (
    <section className="card">
      <div className="card-title">
        <h2>Repos</h2>
        <p className="muted small">
          {ado?.connected ? `Azure DevOps · ${ado.org}, from your ado CLI setup.` : ado ? "Azure DevOps not configured on this machine — run ado init." : " "}
        </p>
      </div>
      {entries.length === 0 && <p className="empty">No repos yet. Add one from Azure DevOps, then use /repo &lt;name&gt; in a thread.</p>}
      {entries.map(([name, r]) => (
        <RepoRow
          key={name}
          name={name}
          repo={r}
          onChange={(next) => void save({ repos: { ...settings.repos, [name]: next } }, `${name} updated`)}
          onRemove={() => {
            const { [name]: _removed, ...rest } = settings.repos;
            void save({ repos: rest }, `${name} removed (files kept on disk)`);
          }}
        />
      ))}
      {ado?.connected && (
        <form
          className="row add-row"
          onSubmit={async (e) => {
            e.preventDefault();
            setCloning(true);
            try {
              setSettings(await api.adoClone(project, repo));
              notify(`${repo} cloned and ready for /repo`);
            } catch (err) {
              notify(err instanceof Error ? err.message : String(err), true);
            }
            setCloning(false);
          }}
        >
          <select value={project} onChange={(e) => setProject(e.target.value)} aria-label="Azure DevOps project">
            <option value="">Project</option>
            {projects.map((p) => (
              <option key={p}>{p}</option>
            ))}
          </select>
          <select className="grow" value={repo} onChange={(e) => setRepo(e.target.value)} aria-label="Repository" disabled={!repos.length}>
            <option value="">Repository</option>
            {repos
              .filter((r) => !settings.repos[r.name])
              .map((r) => (
                <option key={r.id}>{r.name}</option>
              ))}
          </select>
          <button className="btn primary" disabled={!repo || cloning}>
            {cloning ? "Cloning…" : "Add from Azure DevOps"}
          </button>
        </form>
      )}
    </section>
  );
}

function SpacesCard({ settings, save }: ViewProps) {
  const [space, setSpace] = useState("");
  return (
    <section className="card">
      <div className="card-title">
        <h2>Spaces</h2>
        <p className="muted small">Only these Chat spaces reach the agent.</p>
      </div>
      {settings.allowedSpaces.length === 0 && <p className="empty warn-text">No spaces allowed — every Chat event is ignored.</p>}
      <div className="chips">
        {settings.allowedSpaces.map((s) => (
          <span key={s} className="chip static mono">
            {s}
            <button className="x" aria-label={`Remove ${s}`} onClick={() => void save({ allowedSpaces: settings.allowedSpaces.filter((x) => x !== s) }, `${s} removed`)}>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden="true">
                <path d="M6 6l12 12M18 6L6 18" />
              </svg>
            </button>
          </span>
        ))}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const value = space.trim().startsWith("spaces/") ? space.trim() : `spaces/${space.trim()}`;
            void save({ allowedSpaces: [...settings.allowedSpaces, value] }, `${value} added`).then(() => setSpace(""));
          }}
        >
          <label htmlFor="space-new" className="sr-only">
            Add a space
          </label>
          <input id="space-new" className="mono pill-input" value={space} onChange={(e) => setSpace(e.target.value)} placeholder="spaces/XXXX" required />
        </form>
      </div>
    </section>
  );
}
