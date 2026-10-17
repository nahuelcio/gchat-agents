import { useEffect, useMemo, useState, type FocusEvent } from "react";
import { agentTint } from "../agent-color";
import { api, type AdoRepo, type AdoStatus, type Agent, type ContextFooter, type Persona, type RepoConfig, type Settings, type SkillInfo, type TunnelMode, BUILTIN_MCPS } from "../api";
import type { ViewProps } from "../App";
import { GoogleChatCard } from "./GoogleChat";

const FOOTER_OPTIONS: { value: ContextFooter; label: string; hint: string }[] = [
  { value: "every", label: "Every reply", hint: "Always visible" },
  { value: "every5", label: "Every 5 replies", hint: "Occasional reminder" },
  { value: "above60", label: "When it's filling up", hint: "Only once the session passes 60%" },
  { value: "never", label: "Never", hint: "Keep replies clean" },
];

const COMPACT_OPTIONS = [
  { value: 0, label: "Off" },
  { value: 75, label: "75%" },
  { value: 85, label: "85%" },
  { value: 95, label: "95%" },
];

const TUNNEL_OPTIONS: { value: TunnelMode; label: string; hint: string }[] = [
  { value: "auto", label: "Auto", hint: "cloudflared on Windows, opentunnel elsewhere (cloudflared as fallback)." },
  { value: "opentunnel", label: "opentunnel", hint: "Stable URL across restarts. Linux and macOS only (npm i -g opentunnel)." },
  { value: "cloudflared", label: "cloudflared", hint: "Works everywhere and downloads itself. The URL changes on every restart." },
  { value: "off", label: "Off", hint: "No public URL: team chat works, Google Chat needs GOOGLE_TOKEN_AUDIENCE." },
];

export function SettingsView(props: ViewProps) {
  return (
    <>
      <header className="page-head">
        <div>
          <h1>Settings</h1>
          <p className="sub">Changes apply to the next turn. Only the public tunnel needs a restart.</p>
        </div>
      </header>
      <GoogleChatCard {...props} />
      <AgentCard {...props} />
      <PersonasCard {...props} />
      <ContextCard {...props} />
      <TunnelCard {...props} />
      <DriveCard {...props} />
      <ReposCard {...props} />
      <SpacesCard {...props} />
    </>
  );
}

function AgentCard({ settings, save }: ViewProps) {
  const [agents, setAgents] = useState<Agent[]>();
  const [models, setModels] = useState<string[]>([]);
  const [modelsBusy, setModelsBusy] = useState(false);
  const [ocAgents, setOcAgents] = useState<string[]>([]);
  const [ocAgentsBusy, setOcAgentsBusy] = useState(false);
  const driver = settings.agentDriver;
  const [model, setModel] = useState(settings.models[driver] ?? "");
  const [ocAgent, setOcAgent] = useState(settings.agents?.opencode ?? "");

  const loadModels = (refresh = false) => {
    setModelsBusy(true);
    return api.models(driver, refresh).then(setModels, () => setModels([])).finally(() => setModelsBusy(false));
  };

  const loadOcAgents = (refresh = false) => {
    setOcAgentsBusy(true);
    return api.opencodeAgents(refresh).then(setOcAgents, () => setOcAgents([])).finally(() => setOcAgentsBusy(false));
  };

  useEffect(() => {
    api.agents().then(setAgents, () => setAgents([]));
  }, []);
  useEffect(() => {
    void loadModels();
    if (driver === "opencode") void loadOcAgents();
  }, [driver]);
  useEffect(() => {
    setModel(settings.models[driver] ?? "");
  }, [settings.models, driver]);
  useEffect(() => {
    setOcAgent(settings.agents?.opencode ?? "");
  }, [settings.agents]);

  const others = agents?.filter((a) => a.installed && !a.supported) ?? [];

  return (
    <details className="card" open>
      <summary className="card-title">
        <h2>Agent</h2>
        <p className="muted small">
          Detected on this machine{others.length ? `. Also installed, no driver yet: ${others.map((a) => a.name).join(", ")}` : ""}.
        </p>
      </summary>
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
      {driver === "opencode" ? (
        <>
          <OpenCodeAgentPicker
            agents={ocAgents}
            selected={ocAgent}
            busy={ocAgentsBusy}
            onRefresh={() => void loadOcAgents(true)}
            onSelect={(id) => {
              setOcAgent(id);
              void save(
                { agents: { ...settings.agents, opencode: id || undefined } },
                id ? `Default OpenCode agent: ${id}` : "Using OpenCode's default agent",
              );
            }}
          />
          <ModelBrowser
            models={models}
            selected={model}
            busy={modelsBusy}
            onRefresh={() => void loadModels(true)}
            onSelect={(m) => {
              setModel(m);
              void save(
                { models: { ...settings.models, opencode: m || undefined } },
                m ? `Default model: ${m}` : "Using the agent's default model",
              );
            }}
          />
        </>
      ) : (
        <form
          className="row"
          onSubmit={(e) => {
            e.preventDefault();
            const value = model.trim();
            void save({ models: { ...settings.models, [driver]: value || undefined } }, value ? `Default model: ${value}` : "Using the agent's default model");
          }}
        >
          <div className="field grow">
            <div className="field-head">
              <span>Default model</span>
              <button type="button" className="btn linkish" disabled={modelsBusy} onClick={() => void loadModels(true)}>
                {modelsBusy ? "Loading…" : "Refresh list"}
              </button>
            </div>
            <input
              className="mono"
              value={model}
              onChange={(e) => setModel(e.target.value)}
              placeholder="e.g. opus — empty = default"
            />
            <div className="model-chips">
              {modelsBusy && models.length === 0 && <span className="muted small">Loading models…</span>}
              {models.map((m) => (
                <button
                  key={m}
                  type="button"
                  className={`chip ${model === m ? "on" : ""}`}
                  onClick={() => {
                    setModel(m);
                    void save({ models: { ...settings.models, claude: m } }, `Default model: ${m}`);
                  }}
                >
                  {m.replace(/^claude-/, "")}
                </button>
              ))}
            </div>
            <span className="muted small">Threads can override it with /model. Aliases always track the latest model.</span>
          </div>
          <button className="btn primary">Save</button>
        </form>
      )}
    </details>
  );
}

function OpenCodeAgentPicker({
  agents,
  selected,
  busy,
  onRefresh,
  onSelect,
}: {
  agents: string[];
  selected: string;
  busy: boolean;
  onRefresh: () => void;
  onSelect: (id: string) => void;
}) {
  const [draft, setDraft] = useState(selected);
  useEffect(() => {
    setDraft(selected);
  }, [selected]);

  return (
    <div className="oc-agent-picker">
      <div className="field-head">
        <span>Default OpenCode agent</span>
        <button type="button" className="btn linkish" disabled={busy} onClick={onRefresh}>
          {busy ? "Loading…" : "Refresh list"}
        </button>
      </div>
      <div className="model-current">
        <span className="model-current-label">Selected</span>
        {selected ? (
          <>
            <code className="grow">{selected}</code>
            <button type="button" className="btn small" onClick={() => onSelect("")}>
              Clear
            </button>
          </>
        ) : (
          <span className="muted grow">OpenCode default (usually build)</span>
        )}
      </div>
      <div className="model-chips" role="listbox" aria-label="OpenCode agents">
        {busy && agents.length === 0 && <span className="muted small">Loading agents…</span>}
        {!busy && agents.length === 0 && <span className="muted small">No agents listed — try Refresh, or type an id below.</span>}
        {agents.map((id) => (
          <button key={id} type="button" className={`chip ${selected === id ? "on" : ""}`} onClick={() => onSelect(id)}>
            {id}
          </button>
        ))}
      </div>
      <form
        className="row"
        onSubmit={(e) => {
          e.preventDefault();
          onSelect(draft.trim());
        }}
      >
        <label className="field grow">
          <span>Or set by id</span>
          <input
            className="mono"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="e.g. build, plan, ask — empty = default"
            autoComplete="off"
            spellCheck={false}
          />
        </label>
        <button className="btn primary">Save</button>
      </form>
    </div>
  );
}

function ModelBrowser({
  models,
  selected,
  busy,
  onRefresh,
  onSelect,
}: {
  models: string[];
  selected: string;
  busy: boolean;
  onRefresh: () => void;
  onSelect: (id: string) => void;
}) {
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();

  // One search box: every whitespace-separated word must match, so "tb sonnet" or "anthropic opus" both work.
  const matches = useMemo(() => {
    const words = q.split(/\s+/).filter(Boolean);
    const list = words.length
      ? models.filter((m) => words.every((w) => m.toLowerCase().includes(w)))
      : [...models.filter((m) => m.startsWith("opencode-admin/")), ...models.filter((m) => !m.startsWith("opencode-admin/"))];
    return list.slice(0, 40);
  }, [models, q]);
  const [showAll, setShowAll] = useState(false);
  const shown = q || showAll ? matches : matches.slice(0, 6);

  const pick = (id: string) => {
    onSelect(id);
    setQuery("");
  };

  return (
    <div className="model-browser">
      <div className="field-head">
        <span>Default model</span>
        <button type="button" className="btn linkish" disabled={busy} onClick={onRefresh}>
          {busy ? "Loading…" : "Refresh list"}
        </button>
      </div>
      <div className="model-current">
        <span className="model-current-label">Selected</span>
        {selected ? (
          <>
            <code className="grow">{selected}</code>
            <button type="button" className="btn small" onClick={() => onSelect("")}>
              Clear
            </button>
          </>
        ) : (
          <span className="muted grow">OpenCode default (no override)</span>
        )}
      </div>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          // Enter takes the first match, or the typed text as a raw ID (provider/model#variant).
          const first = q ? matches[0] : undefined;
          const value = first ?? query.trim();
          if (value) pick(value);
        }}
      >
        <input
          className="model-filter mono"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={models.length ? `Search ${models.length} models (e.g. "sonnet", "tb opus") or paste an ID — Enter to set` : "Paste a model ID: provider/model"}
          autoComplete="off"
          spellCheck={false}
        />
      </form>
      {busy && models.length === 0 && <p className="muted small">Loading models…</p>}
      {!busy && models.length === 0 && (
        <p className="muted small">No models yet. Run <code>opencode auth login</code>, then Refresh list.</p>
      )}
      {models.length > 0 && (
        <div className="model-browser-scroll" role="listbox" aria-label="OpenCode models">
          {!q && <p className="muted small model-browser-meta">Suggestions — type to search all {models.length}</p>}
          {shown.map((id) => {
            const slash = id.indexOf("/");
            const on = id === selected;
            return (
              <button type="button" key={id} role="option" aria-selected={on} className={`model-row ${on ? "on" : ""}`} onClick={() => pick(id)}>
                <span className="model-row-check" aria-hidden="true">✓</span>
                <span className="model-name">{slash >= 0 ? id.slice(slash + 1) : id}</span>
                {slash >= 0 && <span className="model-group-count">{id.slice(0, slash) === "opencode-admin" ? "TokenBank" : id.slice(0, slash)}</span>}
              </button>
            );
          })}
          {!q && !showAll && matches.length > shown.length && (
            <button type="button" className="btn linkish model-show-all" onClick={() => setShowAll(true)}>
              Show more ({matches.length - shown.length})
            </button>
          )}
          {q && matches.length === 0 && <p className="muted small model-picker-empty">No match — press Enter to use “{query.trim()}” as-is.</p>}
        </div>
      )}
      <span className="muted small">Threads can override it with /model.</span>
    </div>
  );
}

const EMPTY_PERSONA: Persona = { name: "", prompt: "" };

function PersonasCard({ settings, save }: ViewProps) {
  const personas = settings.personas ?? [];
  const [editing, setEditing] = useState<{ index: number; draft: Persona } | null>(null);
  const [ocAgents, setOcAgents] = useState<string[]>([]);
  const [ocAgentsBusy, setOcAgentsBusy] = useState(false);
  const loadOcAgents = (refresh = false) => {
    setOcAgentsBusy(true);
    return api.opencodeAgents(refresh).then(setOcAgents, () => setOcAgents([])).finally(() => setOcAgentsBusy(false));
  };
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  useEffect(() => {
    void loadOcAgents();
    api.skills().then(setSkills, () => setSkills([]));
  }, []);
  const toggle = (key: "skills" | "mcps", value: string) =>
    editing &&
    setEditing({
      ...editing,
      draft: { ...editing.draft, [key]: (editing.draft[key] ?? []).includes(value) ? (editing.draft[key] ?? []).filter((x) => x !== value) : [...(editing.draft[key] ?? []), value] },
    });
  const taken = new Set(personas.map((p) => p.name.toLowerCase()));
  const importable = ocAgents.filter((id) => !taken.has(id.toLowerCase()) && /^[A-Za-z0-9][\w-]{0,31}$/.test(id));
  const setAgent = (id: string) => {
    if (!editing) return;
    const agent = id.trim() || undefined;
    setEditing({
      ...editing,
      draft: { ...editing.draft, agent, driver: agent ? "opencode" : editing.draft.driver },
    });
  };

  const commit = (list: Persona[], msg: string) => save({ personas: list }, msg).then(() => setEditing(null));
  const submit = () => {
    if (!editing) return;
    const draft = { ...editing.draft, name: editing.draft.name.trim().replace(/^@/, ""), prompt: editing.draft.prompt.trim() };
    if (!draft.skills?.length) delete draft.skills;
    if (!draft.mcps?.length) delete draft.mcps;
    if (!draft.model?.trim()) delete draft.model;
    if (!draft.driver) delete draft.driver;
    if (!draft.agent || draft.driver === "claude") delete draft.agent;
    const list = [...personas];
    if (editing.index < 0) list.push(draft);
    else list[editing.index] = draft;
    void commit(list, `@${draft.name} saved`);
  };

  return (
    <details className="card" open>
      <summary className="card-title">
        <h2>Agents in chat</h2>
        <p className="muted small">
          Give agents a name and a role. Write <code>@name</code> in a room to talk to them. Mention two or more (<code>@a @b discutan…</code>) and they dialogue, passing the floor until they agree or you hit Stop.
        </p>
      </summary>
      {personas.length === 0 && !editing && <p className="empty">No agents yet. Add one like <code>@ventas</code> or <code>@soporte</code>.</p>}
      {personas.map((p, i) =>
        editing?.index === i ? null : (
          <div key={p.name} className="repo">
            <div className="repo-name grow">
              <span className="strong agent-tint author" style={agentTint(p.name)}>
                @{p.name}
              </span>
              <span className="muted small">{p.prompt ? p.prompt.slice(0, 120) + (p.prompt.length > 120 ? "…" : "") : "No role yet"}</span>
            </div>
            <span className="muted small">
              {[p.agent ? `OpenCode · ${p.agent}` : (p.driver ?? "default agent"), p.model, p.listen === "all" && "listens to all", p.respondTo === "people" && "people only"].filter(Boolean).join(" · ")}
            </span>
            <button className="btn small" onClick={() => setEditing({ index: i, draft: { ...p } })}>
              Edit
            </button>
            <button className="btn icon ghost" aria-label={`Remove @${p.name}`} onClick={() => void commit(personas.filter((_, j) => j !== i), `@${p.name} removed`)}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                <path d="M6 6l12 12M18 6L6 18" />
              </svg>
            </button>
          </div>
        ),
      )}
      {editing ? (
        <form
          className="persona-form"
          aria-label="Agent in chat"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <div className="row">
            <label className="field narrow">
              <span>Name</span>
              <input
                className="mono"
                value={editing.draft.name}
                onChange={(e) => setEditing({ ...editing, draft: { ...editing.draft, name: e.target.value } })}
                placeholder="ventas"
                pattern="@?[A-Za-z0-9][A-Za-z0-9_\-]{0,31}"
                title="Letters, digits, - or _ (no spaces)"
                required
                autoFocus
              />
            </label>
            <label className="field narrow">
              <span>Runs on</span>
              <select
                value={editing.draft.driver ?? ""}
                onChange={(e) => {
                  const driver = (e.target.value || undefined) as Persona["driver"];
                  setEditing({
                    ...editing,
                    draft: { ...editing.draft, driver, ...(driver === "claude" ? { agent: undefined } : {}) },
                  });
                }}
              >
                <option value="">Default agent</option>
                <option value="claude">Claude Code</option>
                <option value="opencode">OpenCode</option>
              </select>
            </label>
            {editing.draft.driver !== "claude" && (
              <label className="field narrow">
                <div className="field-head">
                  <span>OpenCode agent</span>
                  <button type="button" className="btn linkish" disabled={ocAgentsBusy} onClick={() => void loadOcAgents(true)}>
                    {ocAgentsBusy ? "Loading…" : "Refresh list"}
                  </button>
                </div>
                {ocAgents.length > 0 ? (
                  <select value={editing.draft.agent ?? ""} onChange={(e) => setAgent(e.target.value)}>
                    <option value="">None (plain)</option>
                    {editing.draft.agent && !ocAgents.includes(editing.draft.agent) && (
                      <option value={editing.draft.agent}>{editing.draft.agent}</option>
                    )}
                    {ocAgents.map((id) => (
                      <option key={id} value={id}>
                        {id}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input
                    className="mono"
                    value={editing.draft.agent ?? ""}
                    onChange={(e) => setAgent(e.target.value)}
                    placeholder={ocAgentsBusy ? "Loading…" : "e.g. build, plan — or Refresh"}
                    autoComplete="off"
                    spellCheck={false}
                  />
                )}
              </label>
            )}
            <label className="field grow">
              <span>Model (optional)</span>
              <input
                className="mono"
                value={editing.draft.model ?? ""}
                onChange={(e) => setEditing({ ...editing, draft: { ...editing.draft, model: e.target.value } })}
                placeholder="empty = default"
              />
            </label>
          </div>
          <div className="row">
            <label className="field grow">
              <span>Listens to</span>
              <select
                value={editing.draft.listen ?? "mentions"}
                onChange={(e) => setEditing({ ...editing, draft: { ...editing.draft, listen: e.target.value === "all" ? "all" : undefined } })}
              >
                <option value="mentions">Only when @mentioned</option>
                <option value="all">Every message — can jump into others' chats when useful</option>
              </select>
            </label>
            <label className="field grow">
              <span>Answers</span>
              <select
                value={editing.draft.respondTo ?? "anyone"}
                onChange={(e) => setEditing({ ...editing, draft: { ...editing.draft, respondTo: e.target.value === "people" ? "people" : undefined } })}
              >
                <option value="anyone">People and other agents</option>
                <option value="people">Only people</option>
              </select>
            </label>
          </div>
          <label className="field">
            <span>Role and knowledge</span>
            <textarea
              rows={4}
              value={editing.draft.prompt}
              onChange={(e) => setEditing({ ...editing, draft: { ...editing.draft, prompt: e.target.value } })}
              placeholder="You are the sales agent. You know our plans and prices, answer briefly and in Spanish…"
            />
          </label>
          <fieldset className="field">
            <legend>Skills</legend>
            {skills.length === 0 && <span className="muted small">No skills yet. Add one as data/skills/&lt;name&gt;/SKILL.md.</span>}
            {skills.map((sk) => (
              <label key={sk.name} className="inline check">
                <input type="checkbox" checked={(editing.draft.skills ?? []).includes(sk.name)} onChange={() => toggle("skills", sk.name)} />
                <span>
                  <span className="strong">{sk.name}</span> <span className="muted small">{sk.description}{sk.mcps.length ? ` · uses ${sk.mcps.join(", ")}` : ""}</span>
                </span>
              </label>
            ))}
          </fieldset>
          <fieldset className="field">
            <legend>Tools (MCP)</legend>
            {BUILTIN_MCPS.map((m) => (
              <label key={m.name} className="inline check">
                <input type="checkbox" checked={(editing.draft.mcps ?? []).includes(m.name)} onChange={() => toggle("mcps", m.name)} />
                <span>{m.label}</span>
              </label>
            ))}
            <span className="muted small">Skills turn on the tools they need by themselves.</span>
          </fieldset>
          <div className="row">
            <button className="btn primary">Save</button>
            <button type="button" className="btn" onClick={() => setEditing(null)}>
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <>
          <button className="btn" onClick={() => setEditing({ index: -1, draft: { ...EMPTY_PERSONA } })}>
            + Add agent
          </button>
          <div className="field">
            <div className="field-head">
              <span className="muted small">Or bring an OpenCode agent you already have — it keeps its own instructions and tools:</span>
              <button type="button" className="btn linkish" disabled={ocAgentsBusy} onClick={() => void loadOcAgents(true)}>
                {ocAgentsBusy ? "Loading…" : "Refresh list"}
              </button>
            </div>
            {importable.length > 0 ? (
              <div className="model-chips">
                {importable.map((id) => (
                  <button
                    key={id}
                    type="button"
                    className="chip"
                    onClick={() => void commit([...personas, { name: id, prompt: "", driver: "opencode", agent: id }], `@${id} added`)}
                  >
                    + @{id}
                  </button>
                ))}
              </div>
            ) : (
              <span className="muted small">
                {ocAgentsBusy ? "Loading OpenCode agents…" : "No OpenCode agents listed — try Refresh, or add one above and pick the agent id."}
              </span>
            )}
          </div>
        </>
      )}
    </details>
  );
}

function DriveCard({ settings, save }: ViewProps) {
  const [folder, setFolder] = useState(settings.googleDriveFolderId ?? "");
  return (
    <details className="card" open aria-label="Google Drive">
      <summary className="card-title">
        <h2>Google Drive</h2>
        <p className="muted small">Where agents with the Google Drive tool save files. Share the folder with the service account email as Editor.</p>
      </summary>
      <form
        className="field"
        onSubmit={(e) => {
          e.preventDefault();
          void save({ googleDriveFolderId: folder.trim() }, folder.trim() ? "Drive folder saved" : "Drive folder cleared");
        }}
      >
        <span>Folder id</span>
        <div className="row">
          <input className="mono grow" value={folder} onChange={(e) => setFolder(e.target.value)} placeholder="1AbC… (the part after /folders/ in the folder URL)" />
          <button className="btn">Save</button>
        </div>
      </form>
    </details>
  );
}

function TunnelCard({ settings, save }: ViewProps) {
  const current = TUNNEL_OPTIONS.find((o) => o.value === settings.tunnel) ?? TUNNEL_OPTIONS[0];
  return (
    <details className="card" open>
      <summary className="card-title">
        <h2>Public tunnel</h2>
        <p className="muted small">How Google Chat reaches this machine. Applies on the next restart; TUNNEL in .env overrides it.</p>
      </summary>
      <div className="field">
        <span>Provider</span>
        <fieldset className="chips">
          <legend className="sr-only">Tunnel provider</legend>
          {TUNNEL_OPTIONS.map((o) => (
            <label key={o.value} className={`chip ${current.value === o.value ? "on" : ""}`} title={o.hint}>
              <input type="radio" name="tunnel" checked={current.value === o.value} onChange={() => void save({ tunnel: o.value }, `Tunnel: ${o.label} (restart to apply)`)} />
              {o.label}
            </label>
          ))}
        </fieldset>
        <span className="muted small">{current.hint}</span>
      </div>
    </details>
  );
}

function ContextCard({ settings, save }: ViewProps) {
  const footer = FOOTER_OPTIONS.find((o) => o.value === settings.contextFooter);
  const compact = settings.autoCompactAt;
  return (
    <details className="card" open>
      <summary className="card-title">
        <h2>Context in Chat</h2>
        <p className="muted small">Agents have a limited memory per thread. Choose how often to show how full it is, and when to free it up.</p>
      </summary>

      <div className="field">
        <span>Show usage under replies</span>
        <fieldset className="chips">
          <legend className="sr-only">Show the context footer</legend>
          {FOOTER_OPTIONS.map((o) => (
            <label key={o.value} className={`chip ${settings.contextFooter === o.value ? "on" : ""}`} title={o.hint}>
              <input type="radio" name="footer" checked={settings.contextFooter === o.value} onChange={() => void save({ contextFooter: o.value }, `Context footer: ${o.label.toLowerCase()}`)} />
              {o.label}
            </label>
          ))}
        </fieldset>
        <span className="muted small">{footer?.hint}</span>
      </div>
      {settings.contextFooter !== "never" && (
        <div className="field">
          <span className="muted small">Preview</span>
          <p className="sample mono">— glm-5.3-flash · yFlow@chat/flow-export · context 62% (79k/128k)</p>
          <span className="muted small">Model · repo@branch · memory used. Claude reports exact numbers; OpenCode is an estimate (~).</span>
        </div>
      )}

      <div className="field">
        <span>Auto-compact</span>
        <fieldset className="chips">
          <legend className="sr-only">Compact automatically</legend>
          {COMPACT_OPTIONS.map((o) => (
            <label key={o.value} className={`chip ${compact === o.value ? "on" : ""}`}>
              <input type="radio" name="compact" checked={compact === o.value} onChange={() => void save({ autoCompactAt: o.value }, o.value ? `Auto-compact at ${o.label}` : "Auto-compact off")} />
              {o.label}
            </label>
          ))}
        </fieldset>
        <span className="muted small">
          {compact > 0
            ? `When a thread reaches ${compact}%, the agent summarizes the conversation to free space and posts a note in the thread.`
            : "Threads are never compacted automatically. Use /compact in a thread when needed."}
        </span>
      </div>
    </details>
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
    <details className="card" open>
      <summary className="card-title">
        <h2>Repos</h2>
        <p className="muted small">
          {ado?.connected ? `Azure DevOps · ${ado.org}, from your ado CLI setup.` : ado ? "Azure DevOps not configured on this machine — run ado init." : " "}
        </p>
      </summary>
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
    </details>
  );
}

function SpacesCard({ settings, save }: ViewProps) {
  const [space, setSpace] = useState("");
  return (
    <details className="card" open>
      <summary className="card-title">
        <h2>Google Chat spaces</h2>
        <p className="muted small">Only needed if you use Google Chat: messages from spaces not listed here are ignored. Team chat in this app is not affected.</p>
      </summary>
      {settings.allowedSpaces.length === 0 && (
        <p className="empty">No spaces yet — Google Chat messages are ignored until you add one (the setup test above adds it for you).</p>
      )}
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
          <input id="space-new" className="mono pill-input" value={space} onChange={(e) => setSpace(e.target.value)} placeholder="Add spaces/XXXX + Enter" required />
        </form>
      </div>
    </details>
  );
}
