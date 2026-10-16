import { useEffect, useState, type FocusEvent } from "react";
import { api, type AdoRepo, type AdoStatus, type Agent, type RepoConfig, type Settings, type Thread } from "./api";

export function App() {
  const [settings, setSettings] = useState<Settings>();
  const [message, setMessage] = useState<{ text: string; error?: boolean }>();

  useEffect(() => {
    api.settings().then(setSettings, (e: Error) => setMessage({ text: e.message, error: true }));
  }, []);

  async function act(fn: () => Promise<Settings | unknown>, ok: string) {
    try {
      const out = await fn();
      if (out && typeof out === "object" && "agentDriver" in out) setSettings(out as Settings);
      setMessage({ text: ok });
    } catch (err) {
      setMessage({ text: err instanceof Error ? err.message : String(err), error: true });
    }
  }
  const save = (patch: Partial<Settings>, ok = "Saved") => act(() => api.save(patch), ok);

  return (
    <main>
      <header className="hero">
        <span className="logo" aria-hidden>
          🤖
        </span>
        <div>
          <h1>Control plane</h1>
          <p className="muted">your agents, repos & threads — on this machine</p>
        </div>
      </header>
      {message && <p className={message.error ? "msg error" : "msg"}>{message.text}</p>}
      <Threads />
      {settings && (
        <>
          <AgentSection settings={settings} save={save} />
          <Repos settings={settings} save={save} act={act} />
          <Spaces settings={settings} save={save} />
        </>
      )}
    </main>
  );
}

type SectionProps = { settings: Settings; save: (patch: Partial<Settings>, ok?: string) => Promise<void> };

function Threads() {
  const [threads, setThreads] = useState<Thread[]>([]);
  const [logs, setLogs] = useState<{ slug: string; text: string }>();

  useEffect(() => {
    const load = () => api.threads().then(setThreads, () => {});
    load();
    const id = setInterval(load, 3000);
    return () => clearInterval(id);
  }, []);

  return (
    <section>
      <h2>💬 Threads</h2>
      {threads.length === 0 && <p className="empty">No threads yet — mention the bot in the team space ✨</p>}
      {threads.map((t) => (
        <div className="row" key={t.key}>
          <span className="grow">
            <b>{t.slug}</b> <span className="muted">{t.repo ? `${t.repo} · ${t.branch}` : "chat only"}</span>
          </span>
          {t.app.running && (
            <a className="pill ok" href={`http://localhost:${t.app.port}`} target="_blank" rel="noreferrer">
              ● :{t.app.port}
            </a>
          )}
          {t.repo && <button onClick={() => api.logs(t.slug).then((r) => setLogs({ slug: t.slug, text: r.logs || "No output." }))}>Logs</button>}
          {t.app.running && <button onClick={() => void api.stop(t.slug)}>Stop</button>}
        </div>
      ))}
      {logs && (
        <div className="logs">
          <div className="row">
            <b className="grow">{logs.slug}</b>
            <button onClick={() => setLogs(undefined)}>Close</button>
          </div>
          <pre>{logs.text}</pre>
        </div>
      )}
    </section>
  );
}

function AgentSection({ settings, save }: SectionProps) {
  const [agents, setAgents] = useState<Agent[]>();
  const [models, setModels] = useState<string[]>([]);
  const driver = settings.agentDriver;
  const [model, setModel] = useState(settings.models[driver] ?? "");

  useEffect(() => {
    api.agents().then(setAgents, () => setAgents([]));
    api.models().then(setModels, () => {});
  }, []);
  useEffect(() => setModel(settings.models[driver] ?? ""), [settings.models, driver]);

  const others = agents?.filter((a) => a.installed && !a.supported) ?? [];

  return (
    <section>
      <h2>🧠 Agent</h2>
      {!agents && <p className="muted">Detecting…</p>}
      {agents
        ?.filter((a) => a.supported)
        .map((a) => (
          <label className="row" key={a.id}>
            <input
              type="radio"
              name="driver"
              checked={driver === a.id}
              disabled={!a.installed}
              onChange={() => void save({ agentDriver: a.id as Settings["agentDriver"] }, `Using ${a.name}`)}
            />
            <span className="grow">
              <b>{a.name}</b> <span className="muted">{a.installed ? `v${a.version} · ${a.detail ?? ""}` : "not installed"}</span>
            </span>
            {a.installed && (a.ready ? <span className="pill ok">ready</span> : <span className="pill warn">needs setup</span>)}
          </label>
        ))}
      {others.length > 0 && <p className="muted">Also installed, no driver yet: {others.map((a) => a.name).join(", ")}</p>}

      <form
        className="row"
        onSubmit={(e) => {
          e.preventDefault();
          void save({ models: { ...settings.models, [driver]: model.trim() || undefined } }, model.trim() ? `Model: ${model.trim()}` : "Default model");
        }}
      >
        <input
          className="grow"
          list={driver === "opencode" ? "models" : undefined}
          value={model}
          onChange={(e) => setModel(e.target.value)}
          placeholder={driver === "opencode" ? `Model (${models.length} available) — empty = default` : "Model, e.g. claude-opus-5-5 — empty = default"}
          aria-label="Model"
        />
        <datalist id="models">
          {models.map((m) => (
            <option key={m} value={m} />
          ))}
        </datalist>
        <button className="primary">Save</button>
      </form>
    </section>
  );
}

function Repos({ settings, save, act }: SectionProps & { act: (fn: () => Promise<unknown>, ok: string) => Promise<void> }) {
  const [ado, setAdo] = useState<AdoStatus>();
  const [projects, setProjects] = useState<string[]>([]);
  const [project, setProject] = useState("");
  const [repos, setRepos] = useState<AdoRepo[]>([]);
  const [repo, setRepo] = useState("");
  const [cloning, setCloning] = useState(false);

  useEffect(() => {
    api.adoStatus().then((s) => {
      setAdo(s);
      if (!s.connected) return;
      api.adoProjects().then((list) => {
        setProjects(list.map((p) => p.name));
        // ado CLI profiles are case-insensitive ("ysocial" vs "ySocial").
        const match = list.find((p) => p.name.toLowerCase() === s.defaultProject?.toLowerCase());
        if (match) setProject(match.name);
      }, () => {});
    }, () => setAdo({ connected: false }));
  }, []);
  useEffect(() => {
    setRepos([]);
    setRepo("");
    if (project) api.adoRepos(project).then(setRepos, () => {});
  }, [project]);

  const configured = Object.entries(settings.repos);

  return (
    <section>
      <h2>📦 Repos</h2>
      {configured.length === 0 && <p className="empty">No repos yet — add one below, then use <code>/repo &lt;name&gt;</code> in a thread 🌱</p>}
      {configured.map(([name, r]) => (
        <RepoRow
          key={name}
          name={name}
          repo={r}
          onChange={(next) => void save({ repos: { ...settings.repos, [name]: next } }, `${name} updated`)}
          onRemove={() => {
            const { [name]: _removed, ...rest } = settings.repos;
            void save({ repos: rest }, `${name} removed`);
          }}
        />
      ))}

      {ado && !ado.connected && <p className="muted">Azure DevOps not configured on this machine — run <code>ado init</code>.</p>}
      {ado?.connected && (
        <form
          className="row"
          onSubmit={async (e) => {
            e.preventDefault();
            setCloning(true);
            await act(() => api.adoClone(project, repo), `${repo} cloned`);
            setCloning(false);
          }}
        >
          <select value={project} onChange={(e) => setProject(e.target.value)} aria-label="Project">
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
          <button className="primary" disabled={!repo || cloning}>{cloning ? "Cloning… ⏳" : `Add from ${ado.org}`}</button>
        </form>
      )}
    </section>
  );
}

/** Last two path segments: enough to recognize a clone without the full absolute path. */
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
      <div className="row">
        <span className="grow">
          <b>{name}</b> <span className="muted" title={repo.path}>{shortPath(repo.path)}</span>
        </span>
        <button className="ghost" onClick={onRemove} aria-label={`Remove ${name}`}>
          ✕
        </button>
      </div>
      <div className="row">
        <label className="chip">
          🌿 <input {...field("base")} placeholder="HEAD" aria-label={`Base branch for ${name}`} />
        </label>
        <label className="chip grow">
          ▶ <input {...field("up")} placeholder="up command, e.g. npm run dev -- --port {port}" aria-label={`Up command for ${name}`} />
        </label>
      </div>
    </div>
  );
}

function Spaces({ settings, save }: SectionProps) {
  const [space, setSpace] = useState("");
  return (
    <section>
      <h2>🏠 Spaces</h2>
      {settings.allowedSpaces.length === 0 && <p className="empty error">No spaces yet — the bot is ignoring everyone 🙈</p>}
      {settings.allowedSpaces.map((s) => (
        <div className="row" key={s}>
          <span className="grow">{s}</span>
          <button onClick={() => void save({ allowedSpaces: settings.allowedSpaces.filter((x) => x !== s) }, `${s} removed`)}>Remove</button>
        </div>
      ))}
      <form
        className="row"
        onSubmit={(e) => {
          e.preventDefault();
          const value = space.trim().startsWith("spaces/") ? space.trim() : `spaces/${space.trim()}`;
          void save({ allowedSpaces: [...settings.allowedSpaces, value] }, `${value} added`).then(() => setSpace(""));
        }}
      >
        <input className="grow" value={space} onChange={(e) => setSpace(e.target.value)} placeholder="spaces/XXXX" aria-label="Space" required />
        <button className="primary">Add</button>
      </form>
    </section>
  );
}
