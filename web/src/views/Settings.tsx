import { useEffect, useState, type FocusEvent } from "react";
import { agentTint } from "../agent-color";
import {
  api,
  type AdoRepo,
  type AdoStatus,
  type Agent,
  type ContextFooter,
  type DriveMcpStatus,
  type Persona,
  type PersonaTemplate,
  type RepoConfig,
  type Settings,
  type McpServer,
  type PiCustomProvider,
  type PiKey,
  type SkillInfo,
  type TunnelMode,
  BUILTIN_MCPS,
  DEFAULT_PERSONA_MCPS,
} from "../api";
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

const TABS = [
  { id: "agents", label: "Agents", hint: "Who answers: Pi model and the agents in chat." },
  { id: "tools", label: "Skills & tools", hint: "Skill packs (prompt + tools) and MCP servers for agents." },
  { id: "chat", label: "Chat", hint: "Google Chat, spaces and how context shows up." },
  { id: "connections", label: "Connections", hint: "Public tunnel, Google Drive and repos." },
] as const;

type TabId = (typeof TABS)[number]["id"];

const tabFromHash = (): TabId => {
  const sub = location.hash.split("/")[1];
  return (TABS.find((t) => t.id === sub)?.id ?? "agents") as TabId;
};

export function SettingsView(props: ViewProps) {
  const [tab, setTab] = useState<TabId>(tabFromHash);
  useEffect(() => {
    const onHash = () => setTab(tabFromHash());
    addEventListener("hashchange", onHash);
    return () => removeEventListener("hashchange", onHash);
  }, []);
  const current = TABS.find((t) => t.id === tab)!;
  return (
    <>
      <header className="page-head">
        <div>
          <h1>Settings</h1>
          <p className="sub">Changes apply to the next turn. Only the public tunnel needs a restart.</p>
        </div>
      </header>
      <nav className="settings-tabs" role="tablist" aria-label="Settings sections">
        {TABS.map((t) => (
          <a key={t.id} role="tab" aria-selected={tab === t.id} className={tab === t.id ? "on" : ""} href={`#settings/${t.id}`}>
            {t.label}
          </a>
        ))}
      </nav>
      <p className="muted small settings-hint">{current.hint}</p>
      {tab === "agents" && (
        <>
          <PersonasCard {...props} />
          <AgentCard {...props} />
        </>
      )}
      {tab === "tools" && (
        <>
          <SkillsCard {...props} />
          <McpServersCard {...props} />
        </>
      )}
      {tab === "chat" && (
        <>
          <BatchingCard {...props} />
          <ContextCard {...props} />
          <GoogleChatCard {...props} />
          <SpacesCard {...props} />
        </>
      )}
      {tab === "connections" && (
        <>
          <TunnelCard {...props} />
          <DriveCard {...props} />
          <ReposCard {...props} />
        </>
      )}
    </>
  );
}

function personaChips(p: Persona): string[] {
  return [
    p.model ? `Pi · ${p.model}` : "Pi",
    p.skills?.length ? `skills: ${p.skills.join(", ")}` : "",
    p.mcps?.length ? `tools: ${p.mcps.join(", ")}` : "all tools",
    p.delegates?.length ? `asks ${p.delegates.map((d) => `@${d}`).join(", ")}` : "",
    p.listen === "all" ? "listens to all" : "",
    p.respondTo === "people" ? "people only" : "",
  ].filter(Boolean);
}

function AgentCard({ settings, save, notify }: ViewProps) {
  const [pi, setPi] = useState<Agent>();
  const [models, setModels] = useState<string[]>([]);
  const [modelsBusy, setModelsBusy] = useState(false);
  const [model, setModel] = useState(settings.models.pi ?? "");

  const loadModels = (refresh = false) => {
    setModelsBusy(true);
    return api.models(refresh).then(setModels, () => setModels([])).finally(() => setModelsBusy(false));
  };

  useEffect(() => {
    api.agents().then(
      (list) => setPi(list.find((a) => a.id === "pi")),
      () => setPi(undefined),
    );
    void loadModels();
  }, []);
  useEffect(() => {
    setModel(settings.models.pi ?? "");
  }, [settings.models.pi]);

  return (
    <details className="card" open>
      <summary className="card-title">
        <h2>Pi</h2>
        <p className="muted small">Durable harness for every chat turn.</p>
      </summary>
      {!pi && <p className="muted">Detecting…</p>}
      {pi && (
        <p className="small">
          <span className="strong">{pi.name}</span> {pi.installed && <code className="muted">{pi.version}</code>}
          <span className={`block ${pi.ready ? "ok-text" : "warn-text"}`}>
            {!pi.installed ? "Not installed" : `${pi.ready ? "Ready" : "Needs setup"} · ${pi.detail ?? ""}`}
          </span>
        </p>
      )}
      <form
        className="row"
        onSubmit={(e) => {
          e.preventDefault();
          const value = model.trim();
          void save({ models: { pi: value || undefined } }, value ? `Default model: ${value}` : "Using the agent's default model");
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
            placeholder="provider/model, e.g. anthropic/claude-sonnet-5-5 — needs that provider's API key"
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
                  void save({ models: { pi: m } }, `Default model: ${m}`);
                }}
              >
                {m}
              </button>
            ))}
          </div>
          <span className="muted small">Threads can override it with /model.</span>
        </div>
        <button className="btn primary">Save</button>
      </form>
      <PiKeys notify={notify} />
      <PiCustomProviders notify={notify} />
    </details>
  );
}

const EMPTY_PERSONA: Persona = { name: "", prompt: "", mcps: [...DEFAULT_PERSONA_MCPS] };

function cleanPersona(raw: Persona): Persona {
  const draft: Persona = { ...raw, name: raw.name.trim().replace(/^@/, ""), prompt: raw.prompt.trim() };
  if (!draft.skills?.length) delete draft.skills;
  if (!draft.mcps?.length) delete draft.mcps;
  if (!draft.delegates?.length || !draft.mcps?.includes("agents")) delete draft.delegates;
  if (!draft.model?.trim()) delete draft.model;
  if (draft.listen !== "all") delete draft.listen;
  if (draft.respondTo !== "people") delete draft.respondTo;
  return draft;
}

function withDefaultMcps(current: string[] | undefined, value: string): string[] {
  const list = current ?? [];
  if (list.includes(value)) return list.filter((x) => x !== value);
  if (list.length === 0) {
    return DEFAULT_PERSONA_MCPS.includes(value) ? [...DEFAULT_PERSONA_MCPS] : [...DEFAULT_PERSONA_MCPS, value];
  }
  return [...list, value];
}

function uniqueAgentName(base: string, taken: Set<string>): string {
  const root = (base || "agent").replace(/^@/, "").slice(0, 28) || "agent";
  if (!taken.has(root.toLowerCase())) return root;
  for (let n = 2; n < 100; n++) {
    const candidate = `${root}${n}`.slice(0, 32);
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
  return `${root}${Date.now().toString(36)}`.slice(0, 32);
}

function templateIdFrom(name: string, existing: PersonaTemplate[]): string {
  const root = (name || "template")
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "template";
  const ids = new Set(existing.map((t) => t.id));
  if (!ids.has(root)) return root;
  for (let n = 2; n < 100; n++) {
    const id = `${root}-${n}`.slice(0, 48);
    if (!ids.has(id)) return id;
  }
  return `${root}-${Date.now().toString(36)}`.slice(0, 48);
}

function personaFromTemplate(t: PersonaTemplate): Persona {
  const { id: _id, ...fields } = t;
  return cleanPersona({ ...fields });
}

function PersonasCard({ settings, save, notify }: ViewProps) {
  const personas = settings.personas ?? [];
  const templates = settings.templates ?? [];
  const [editing, setEditing] = useState<{ index: number; draft: Persona } | null>(null);
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const [aiBrief, setAiBrief] = useState("");
  const [aiBusy, setAiBusy] = useState(false);
  useEffect(() => {
    api.skills().then(setSkills, () => setSkills([]));
  }, []);
  const toggle = (key: "skills" | "mcps" | "delegates", value: string) =>
    editing &&
    setEditing({
      ...editing,
      draft: {
        ...editing.draft,
        [key]: key === "mcps" ? withDefaultMcps(editing.draft.mcps, value) : (editing.draft[key] ?? []).includes(value) ? (editing.draft[key] ?? []).filter((x) => x !== value) : [...(editing.draft[key] ?? []), value],
      },
    });

  const commit = (list: Persona[], msg: string) => save({ personas: list }, msg).then(() => setEditing(null));
  const commitTemplates = (list: PersonaTemplate[], msg: string) => save({ templates: list }, msg);
  const submit = () => {
    if (!editing) return;
    const draft = cleanPersona(editing.draft);
    const list = [...personas];
    if (editing.index < 0) list.push(draft);
    else list[editing.index] = draft;
    void commit(list, `@${draft.name} saved`);
  };

  const runAiDraft = () => {
    const brief = (aiBrief || editing?.draft.prompt || editing?.draft.name || "").trim();
    if (!brief || aiBusy || !editing) return;
    setAiBusy(true);
    api
      .draftAgent(brief, editing.draft)
      .then(
        (draft) => {
          setEditing({ index: editing.index, draft: { ...EMPTY_PERSONA, ...draft } });
          setAiBrief("");
          notify("Draft improved — review and Save");
        },
        (e: Error) => notify(e.message, true),
      )
      .finally(() => setAiBusy(false));
  };

  const duplicate = (p: Persona) => {
    const taken = new Set(personas.map((x) => x.name.toLowerCase()));
    const copy = cleanPersona({ ...p, name: uniqueAgentName(p.name, taken) });
    void commit([...personas, copy], `@${copy.name} duplicated from @${p.name}`);
  };

  const saveAsTemplate = (p: Persona) => {
    const cleaned = cleanPersona(p);
    const id = templateIdFrom(cleaned.name, templates);
    const tpl: PersonaTemplate = { id, ...cleaned };
    void commitTemplates([...templates, tpl], `Template ${id} saved`);
  };

  const applyTemplate = (t: PersonaTemplate) => {
    const next = personaFromTemplate(t);
    const idx = personas.findIndex((p) => p.name.toLowerCase() === next.name.toLowerCase());
    const list = [...personas];
    if (idx >= 0) {
      list[idx] = next;
      void commit(list, `@${next.name} updated from template`);
    } else {
      list.push(next);
      void commit(list, `@${next.name} created from template`);
    }
  };

  const removeTemplate = (id: string) => void commitTemplates(
    templates.filter((t) => t.id !== id),
    `Template ${id} removed`,
  );

  return (
    <details className="card" open>
      <summary className="card-title">
        <h2>Agents in chat</h2>
        <p className="muted small">
          Assemble agents as a name, listen mode, and skill packs. Write <code>@name</code> in a room to talk to them. Mention two or more (<code>@a @b discutan…</code>) and they dialogue.
          Save a working agent as a template to reuse elsewhere.
        </p>
      </summary>
      {personas.length === 0 && !editing && <p className="empty">No agents yet. Add one like <code>@ventas</code>, or apply a template below.</p>}
      {personas.map((p, i) =>
        editing?.index === i ? null : (
          <div key={p.name} className="repo">
            <div className="repo-name grow">
              <span className="strong agent-tint author" style={agentTint(p.name)}>
                @{p.name}
              </span>
              <span className="muted small">{p.prompt ? p.prompt.slice(0, 120) + (p.prompt.length > 120 ? "…" : "") : "No role yet"}</span>
            </div>
            <span className="persona-chips">
              {personaChips(p).map((c) => (
                <span key={c} className="chip static">
                  {c}
                </span>
              ))}
            </span>
            <button className="btn small" onClick={() => setEditing({ index: i, draft: { ...p } })}>
              Edit
            </button>
            <button className="btn small" onClick={() => duplicate(p)}>
              Duplicate
            </button>
            <button className="btn small" onClick={() => saveAsTemplate(p)}>
              Save as template
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
            <label className="field grow">
              <span>Model (optional)</span>
              <input
                className="mono"
                value={editing.draft.model ?? ""}
                onChange={(e) => setEditing({ ...editing, draft: { ...editing.draft, model: e.target.value } })}
                placeholder="Pi model, e.g. anthropic/claude-sonnet-5-5 — empty = default"
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
              placeholder="Short role text — put reusable know-how in skill packs below."
            />
          </label>
          <fieldset className="field">
            <legend>Skill packs</legend>
            {skills.length === 0 && <span className="muted small">No skill packs yet. Create one under Skills &amp; tools, or add <code>skills/&lt;name&gt;/SKILL.md</code>.</span>}
            {skills.map((sk) => (
              <label key={sk.name} className="inline check">
                <input type="checkbox" checked={(editing.draft.skills ?? []).includes(sk.name)} onChange={() => toggle("skills", sk.name)} />
                <span>
                  <span className="strong">{sk.name}</span> <span className="muted small">{sk.description}{sk.mcps.length ? ` · pack tools: ${sk.mcps.join(", ")}` : ""}</span>
                </span>
              </label>
            ))}
          </fieldset>
          <fieldset className="field">
            <legend>Extra tools</legend>
            {[...BUILTIN_MCPS, ...(settings.mcpServers ?? []).map((m) => ({ name: m.name, label: `${m.name} — your MCP server (${m.command})` }))].map((m) => (
              <label key={m.name} className="inline check">
                <input type="checkbox" checked={(editing.draft.mcps ?? []).includes(m.name)} onChange={() => toggle("mcps", m.name)} />
                <span>{m.label}</span>
              </label>
            ))}
            <span className="muted small">None checked = every tool. Skill packs already turn on the tools they list.</span>
          </fieldset>
          {(editing.draft.mcps ?? []).includes("agents") && (
            <fieldset className="field">
              <legend>Can ask</legend>
              {personas
                .filter((p) => p.name !== editing.draft.name)
                .map((p) => (
                  <label key={p.name} className="inline check">
                    <input type="checkbox" checked={(editing.draft.delegates ?? []).includes(p.name)} onChange={() => toggle("delegates", p.name)} />
                    <span>@{p.name}</span>
                  </label>
                ))}
              <span className="muted small">None checked = any other agent.</span>
            </fieldset>
          )}
          <label className="field">
            <span>Improve with AI</span>
            <div className="row">
              <input
                className="grow"
                value={aiBrief}
                onChange={(e) => setAiBrief(e.target.value)}
                placeholder="What to change or strengthen (optional if the role is already set)"
                disabled={aiBusy}
              />
              <button type="button" className="btn" disabled={aiBusy} onClick={() => runAiDraft()}>
                {aiBusy ? "Generating…" : "Improve with AI"}
              </button>
            </div>
          </label>
          <div className="row">
            <button className="btn primary">Save</button>
            <button type="button" className="btn" onClick={() => setEditing(null)}>
              Cancel
            </button>
            {editing.index >= 0 && (
              <button type="button" className="btn" onClick={() => saveAsTemplate(editing.draft)}>
                Save as template
              </button>
            )}
          </div>
        </form>
      ) : (
        <div className="row" style={{ flexWrap: "wrap", gap: "0.5rem" }}>
          <button className="btn" onClick={() => setEditing({ index: -1, draft: { ...EMPTY_PERSONA } })}>
            + Add agent
          </button>
          <a className="btn" href="#create">
            Create with AI
          </a>
        </div>
      )}

      <div className="card-title" style={{ marginTop: "1.25rem" }}>
        <h3>Templates</h3>
        <p className="muted small">Blueprints with the same fields as an agent. Apply creates <code>@name</code> or updates it if it already exists.</p>
      </div>
      {templates.length === 0 && <p className="empty">No templates yet. Use Save as template on an agent.</p>}
      {templates.map((t) => (
        <div key={t.id} className="repo">
          <div className="repo-name grow">
            <span className="strong">{t.id}</span>
            <span className="muted small">
              → @{t.name}
              {t.prompt ? ` · ${t.prompt.slice(0, 80)}${t.prompt.length > 80 ? "…" : ""}` : ""}
            </span>
          </div>
          <span className="persona-chips">
            {personaChips(t).map((c) => (
              <span key={c} className="chip static">
                {c}
              </span>
            ))}
          </span>
          <button className="btn small primary" onClick={() => applyTemplate(t)}>
            Apply template
          </button>
          <button className="btn small" onClick={() => setEditing({ index: -1, draft: personaFromTemplate(t) })}>
            Edit as new
          </button>
          <button className="btn icon ghost" aria-label={`Remove template ${t.id}`} onClick={() => removeTemplate(t.id)}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </div>
      ))}
    </details>
  );
}

const EMPTY_SKILL: SkillInfo = { name: "", description: "", mcps: [], body: "" };

function SkillsCard({ settings, notify }: ViewProps) {
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const [draft, setDraft] = useState<SkillInfo | null>(null);
  const [isNew, setIsNew] = useState(false);
  const [source, setSource] = useState("");
  const [installing, setInstalling] = useState(false);
  const [aiBrief, setAiBrief] = useState("");
  const [aiBusy, setAiBusy] = useState(false);
  useEffect(() => {
    api.skills().then(setSkills, () => setSkills([]));
  }, []);
  const groups = [...BUILTIN_MCPS.map((m) => m.name), ...(settings.mcpServers ?? []).map((m) => m.name)];
  const run = (p: Promise<SkillInfo[]>, ok: string) =>
    p.then(
      (list) => {
        setSkills(list);
        setDraft(null);
        notify(ok);
      },
      (e: Error) => notify(e.message, true),
    );
  const runAiDraft = () => {
    const brief = (aiBrief || draft?.description || draft?.name || "").trim();
    if (!brief || aiBusy || !draft) return;
    setAiBusy(true);
    api
      .draftSkill(brief, draft)
      .then(
        (next) => {
          setDraft({ ...EMPTY_SKILL, ...next });
          setAiBrief("");
          notify("Draft improved — review and Save");
        },
        (e: Error) => notify(e.message, true),
      )
      .finally(() => setAiBusy(false));
  };
  return (
    <details className="card" open aria-label="Skill packs">
      <summary className="card-title">
        <h2>Skill packs</h2>
        <p className="muted small">
          Reusable packs: prompt text + tools (frontmatter <code>mcps</code> in <code>SKILL.md</code>). Attach packs to agents in Agents — a persona is often just a name, listen mode, and skill packs.
        </p>
      </summary>
      <form
        className="row"
        aria-label="Install from skills.sh"
        onSubmit={(e) => {
          e.preventDefault();
          const spec = source.trim();
          if (!spec || installing) return;
          setInstalling(true);
          api
            .installSkill(spec)
            .then(
              ({ installed, skills: list }) => {
                setSkills(list);
                setSource("");
                notify(installed.length ? `Installed ${installed.join(", ")}` : "Nothing new to install");
              },
              (err: Error) => notify(err.message, true),
            )
            .finally(() => setInstalling(false));
        }}
      >
        <input
          className="mono grow"
          value={source}
          onChange={(e) => setSource(e.target.value)}
          placeholder="owner/repo@skill, or a skills.sh / GitHub link"
          aria-label="Skill source"
        />
        <button className="btn" disabled={!source.trim() || installing}>
          {installing ? "Installing…" : "Install"}
        </button>
      </form>
      {skills.map((sk) => (
        <div key={sk.name} className="persona-row">
          <div className="grow">
            <span className="strong">{sk.name}</span> <span className="muted small">{sk.description}</span>
            {sk.mcps.length > 0 && <div className="muted small">Tools: {sk.mcps.join(", ")}</div>}
          </div>
          <button className="btn small" onClick={() => { setIsNew(false); setDraft({ ...sk }); }}>
            Edit
          </button>
          <button className="x" aria-label={`Delete skill ${sk.name}`} onClick={() => void run(api.deleteSkill(sk.name), `Skill ${sk.name} deleted`)}>
            ×
          </button>
        </div>
      ))}
      {draft ? (
        <form
          className="persona-form"
          aria-label="Skill"
          onSubmit={(e) => {
            e.preventDefault();
            void run(api.saveSkill({ ...draft, name: draft.name.trim().toLowerCase() }), `Skill ${draft.name} saved`);
          }}
        >
          <label className="field">
            <span>Name</span>
            <input value={draft.name} disabled={!isNew} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="ventas" required />
          </label>
          <label className="field">
            <span>Description</span>
            <input value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} placeholder="Precios, planes y cotizaciones" />
          </label>
          <fieldset className="field">
            <legend>Needs tools</legend>
            {groups.map((g) => (
              <label key={g} className="inline check">
                <input
                  type="checkbox"
                  checked={draft.mcps.includes(g)}
                  onChange={() => setDraft({ ...draft, mcps: draft.mcps.includes(g) ? draft.mcps.filter((x) => x !== g) : [...draft.mcps, g] })}
                />
                <span>{g}</span>
              </label>
            ))}
          </fieldset>
          <label className="field">
            <span>Instructions</span>
            <textarea rows={8} value={draft.body} onChange={(e) => setDraft({ ...draft, body: e.target.value })} placeholder="What the agent must do, never do, and how to answer." />
          </label>
          <label className="field">
            <span>Improve with AI</span>
            <div className="row">
              <input
                className="grow"
                value={aiBrief}
                onChange={(e) => setAiBrief(e.target.value)}
                placeholder="What to change or strengthen (optional)"
                disabled={aiBusy}
              />
              <button type="button" className="btn" disabled={aiBusy} onClick={() => runAiDraft()}>
                {aiBusy ? "Generating…" : "Improve with AI"}
              </button>
            </div>
          </label>
          <div className="row">
            <button className="btn primary">Save skill</button>
            <button type="button" className="btn" onClick={() => setDraft(null)}>
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <div className="row" style={{ flexWrap: "wrap", gap: "0.5rem" }}>
          <button className="btn" onClick={() => { setIsNew(true); setDraft({ ...EMPTY_SKILL }); }}>
            + New skill pack
          </button>
          <a className="btn" href="#create">
            Create with AI
          </a>
        </div>
      )}
    </details>
  );
}

const EMPTY_SERVER = { name: "", command: "", args: "", env: "" };

function McpServersCard({ settings, save, setSettings, notify }: ViewProps) {
  const servers = settings.mcpServers ?? [];
  const [draft, setDraft] = useState<typeof EMPTY_SERVER | null>(null);
  const [blob, setBlob] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const commit = (list: McpServer[], ok: string) => save({ mcpServers: list }, ok);
  return (
    <details className="card" open aria-label="MCP servers">
      <summary className="card-title">
        <h2>MCP servers</h2>
        <p className="muted small">
          Bring any MCP server (stdio). Paste a Claude or Cursor mcp.json, or add one by hand. Its tools show up as name__tool for the agents you allow, on every runtime. If{" "}
          <code>engram</code> is installed, it is registered automatically (remove it here to opt out).
        </p>
      </summary>
      {blob !== null ? (
        <form
          className="persona-form"
          aria-label="Import MCP JSON"
          onSubmit={(e) => {
            e.preventDefault();
            if (importing) return;
            setImporting(true);
            api
              .importMcp(blob)
              .then(
                ({ imported, skipped, settings: next }) => {
                  setSettings(next);
                  setBlob(null);
                  const skip = skipped.length ? ` Skipped ${skipped.join(", ")} (remote URL; this app runs a local command).` : "";
                  notify(`Imported ${imported.join(", ") || "nothing"}.${skip}`);
                },
                (err: Error) => notify(err.message, true),
              )
              .finally(() => setImporting(false));
          }}
        >
          <label className="field">
            <span>mcp.json</span>
            <textarea className="mono" rows={8} value={blob} onChange={(e) => setBlob(e.target.value)} placeholder={'{\n  "mcpServers": {\n    "github": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-github"] }\n  }\n}'} aria-label="MCP JSON" required />
          </label>
          <div className="row">
            <button className="btn primary" disabled={!blob.trim() || importing}>
              {importing ? "Importing…" : "Import"}
            </button>
            <button type="button" className="btn" onClick={() => setBlob(null)}>
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <button className="btn" onClick={() => setBlob("")}>
          Paste mcp.json
        </button>
      )}
      {servers.map((m) => (
        <div key={m.name} className="persona-row">
          <div className="grow">
            <span className="strong">{m.name}</span> <code className="muted small">{[m.command, ...m.args].join(" ")}</code>
            {m.env && Object.keys(m.env).length > 0 && <div className="muted small">env: {Object.keys(m.env).join(", ")}</div>}
          </div>
          <button className="x" aria-label={`Remove MCP ${m.name}`} onClick={() => void commit(servers.filter((x) => x.name !== m.name), `${m.name} removed`)}>
            ×
          </button>
        </div>
      ))}
      {draft ? (
        <form
          className="persona-form"
          aria-label="MCP server"
          onSubmit={(e) => {
            e.preventDefault();
            const env = Object.fromEntries(
              draft.env
                .split("\n")
                .map((l) => l.trim())
                .filter((l) => l.includes("="))
                .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()]),
            );
            const server: McpServer = { name: draft.name.trim().toLowerCase(), command: draft.command.trim(), args: draft.args.split(" ").filter(Boolean), env };
            void commit([...servers, server], `${server.name} added`).then(() => setDraft(null));
          }}
        >
          <label className="field">
            <span>Name</span>
            <input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="github" required />
          </label>
          <label className="field">
            <span>Command</span>
            <input className="mono" value={draft.command} onChange={(e) => setDraft({ ...draft, command: e.target.value })} placeholder="npx" required />
          </label>
          <label className="field">
            <span>Arguments</span>
            <input className="mono" value={draft.args} onChange={(e) => setDraft({ ...draft, args: e.target.value })} placeholder="-y @modelcontextprotocol/server-github" />
          </label>
          <label className="field">
            <span>Environment (one KEY=value per line)</span>
            <textarea className="mono" rows={3} value={draft.env} onChange={(e) => setDraft({ ...draft, env: e.target.value })} placeholder="GITHUB_PERSONAL_ACCESS_TOKEN=..." />
          </label>
          <div className="row">
            <button className="btn primary">Add server</button>
            <button type="button" className="btn" onClick={() => setDraft(null)}>
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <button className="btn" onClick={() => setDraft({ ...EMPTY_SERVER })}>
          + Add MCP server
        </button>
      )}
    </details>
  );
}

function PiKeys({ notify }: { notify: ViewProps["notify"] }) {
  const [keys, setKeys] = useState<PiKey[]>();
  const [provider, setProvider] = useState("zai");
  const [key, setKey] = useState("");
  useEffect(() => {
    api.piKeys().then(setKeys, () => setKeys([]));
  }, []);
  const store = (value: string, ok: string) =>
    api.setPiKey(provider, value).then(
      (list) => {
        setKeys(list);
        setKey("");
        notify(ok);
      },
      (e: Error) => notify(e.message, true),
    );
  const current = keys?.find((k) => k.provider === provider);
  return (
    <div className="field" aria-label="Provider keys" role="group">
      <span>Provider keys</span>
      <span className="muted small">Pi calls the model directly. Built-in provider keys are stored on this machine, never shown again, and used from the next turn.</span>
      <form
        className="row"
        onSubmit={(e) => {
          e.preventDefault();
          if (key.trim()) void store(key, `${current?.label ?? provider} key saved`);
        }}
      >
        <select value={provider} onChange={(e) => setProvider(e.target.value)} aria-label="Provider">
          {keys?.map((k) => (
            <option key={k.provider} value={k.provider}>
              {k.label}
              {k.source === "none" ? "" : " ✓"}
            </option>
          ))}
        </select>
        <input className="mono grow" type="password" value={key} onChange={(e) => setKey(e.target.value)} placeholder={`Paste the ${current?.envVar ?? "API key"}`} aria-label="API key" autoComplete="off" />
        <button className="btn" disabled={!key.trim()}>
          Save key
        </button>
        {current?.source === "settings" && (
          <button type="button" className="btn ghost" onClick={() => void store("", `${current.label} key removed`)}>
            Remove
          </button>
        )}
      </form>
      <span className="muted small">
        {current?.source === "settings" ? "Saved here." : current?.source === "env" ? `Taken from ${current.envVar} in .env.` : "Not configured yet."}
      </span>
    </div>
  );
}

const EMPTY_CUSTOM = { id: "", name: "", baseUrl: "http://127.0.0.1:11434/v1", models: "", apiKey: "" };

function PiCustomProviders({ notify }: { notify: ViewProps["notify"] }) {
  const [list, setList] = useState<PiCustomProvider[]>([]);
  const [draft, setDraft] = useState<typeof EMPTY_CUSTOM | null>(null);
  useEffect(() => {
    api.piCustomProviders().then(setList, () => setList([]));
  }, []);
  const remove = (id: string) =>
    api.deletePiCustomProvider(id).then(
      (next) => {
        setList(next);
        notify(`${id} removed`);
      },
      (e: Error) => notify(e.message, true),
    );
  return (
    <div className="field" aria-label="OpenAI-compatible providers" role="group">
      <span>OpenAI-compatible</span>
      <span className="muted small">
        Ollama, vLLM, LM Studio, or any OpenAI-compatible base URL. Use as <code>id/model</code> in Default model (e.g. <code>ollama/llama3.1</code>). Key optional for local servers.
      </span>
      {list.map((p) => (
        <div key={p.id} className="persona-row">
          <div className="grow">
            <span className="strong">{p.name}</span> <code className="muted small">{p.id}</code>
            <div className="muted small mono">
              {p.baseUrl} · {p.models.join(", ")}
              {p.keySource === "none" ? " · no key" : p.keySource === "env" ? ` · ${p.apiKeyEnv}` : " · key saved"}
            </div>
          </div>
          <button className="x" aria-label={`Remove ${p.id}`} onClick={() => void remove(p.id)}>
            ×
          </button>
        </div>
      ))}
      {draft ? (
        <form
          className="persona-form"
          aria-label="OpenAI-compatible provider"
          onSubmit={(e) => {
            e.preventDefault();
            const id = draft.id.trim().toLowerCase();
            const models = draft.models
              .split(/[\s,]+/)
              .map((m) => m.trim())
              .filter(Boolean);
            void api
              .savePiCustomProvider({
                id,
                name: draft.name.trim() || id,
                baseUrl: draft.baseUrl.trim(),
                models,
                apiKey: draft.apiKey.trim() || undefined,
              })
              .then(
                (next) => {
                  setList(next);
                  setDraft(null);
                  notify(`${id} saved — use ${id}/${models[0] ?? "model"}`);
                },
                (err: Error) => notify(err.message, true),
              );
          }}
        >
          <label className="field">
            <span>Id</span>
            <input className="mono" value={draft.id} onChange={(e) => setDraft({ ...draft, id: e.target.value })} placeholder="ollama" required aria-label="Provider id" />
          </label>
          <label className="field">
            <span>Name</span>
            <input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="Ollama" aria-label="Provider name" />
          </label>
          <label className="field">
            <span>Base URL</span>
            <input className="mono" value={draft.baseUrl} onChange={(e) => setDraft({ ...draft, baseUrl: e.target.value })} placeholder="http://127.0.0.1:11434/v1" required aria-label="Base URL" />
          </label>
          <label className="field">
            <span>Models (space or comma separated)</span>
            <input className="mono" value={draft.models} onChange={(e) => setDraft({ ...draft, models: e.target.value })} placeholder="llama3.1 qwen2.5-coder" required aria-label="Models" />
          </label>
          <label className="field">
            <span>API key (optional)</span>
            <input className="mono" type="password" value={draft.apiKey} onChange={(e) => setDraft({ ...draft, apiKey: e.target.value })} placeholder="Leave empty for local servers" aria-label="Custom API key" autoComplete="off" />
          </label>
          <div className="row">
            <button className="btn primary">Add endpoint</button>
            <button type="button" className="btn" onClick={() => setDraft(null)}>
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <button className="btn" onClick={() => setDraft({ ...EMPTY_CUSTOM })}>
          + Add OpenAI-compatible endpoint
        </button>
      )}
    </div>
  );
}

function DriveCard({ settings, save, notify }: ViewProps) {
  const [folder, setFolder] = useState(settings.googleDriveFolderId ?? "");
  const [mcp, setMcp] = useState<DriveMcpStatus>();
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.driveMcp().then((status) => {
      setMcp(status);
      setClientId(status.clientId ?? "");
    }, () => {});
  }, []);

  async function connect() {
    setBusy(true);
    try {
      const { url } = await api.driveMcpStart();
      window.open(url, "_blank", "noopener");
      for (let i = 0; i < 60; i++) {
        await new Promise((r) => setTimeout(r, 2000));
        const next = await api.driveMcp();
        setMcp(next);
        if (next.connected) {
          notify("Google Drive connected");
          return;
        }
      }
    } catch (err) {
      notify(err instanceof Error ? err.message : String(err), true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <details className="card" open aria-label="Google Drive">
      <summary className="card-title">
        <h2>Google Drive</h2>
        <p className="muted small">
          Spreadsheets use the folder below. Docs, slides, search and reading files use{" "}
          <a href="https://developers.google.com/workspace/drive/api/guides/configure-mcp-server?hl=es-419" target="_blank" rel="noreferrer">
            Google's Drive MCP
          </a>
          . It is a Workspace developer preview and signs in as a person, not the service account.
        </p>
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
      <form
        className="field"
        onSubmit={(e) => {
          e.preventDefault();
          setBusy(true);
          api
            .driveMcpSave(clientId.trim(), clientSecret)
            .then((status) => {
              setMcp(status);
              setClientSecret("");
              notify("OAuth client saved");
            }, (err: Error) => notify(err.message, true))
            .finally(() => setBusy(false));
        }}
      >
        <span>OAuth client</span>
        <input className="mono" value={clientId} onChange={(e) => setClientId(e.target.value)} placeholder="Client id" autoComplete="off" />
        <input className="mono" type="password" value={clientSecret} onChange={(e) => setClientSecret(e.target.value)} placeholder={mcp?.configured ? "Client secret saved — paste a new one to replace it" : "Client secret"} autoComplete="off" />
        {mcp?.redirectUri && <code className="muted small">{mcp.redirectUri}</code>}
        <div className="row">
          <button className="btn" disabled={busy || !clientId.trim()}>
            Save client
          </button>
          <button type="button" className="btn primary" disabled={busy || !mcp?.configured} onClick={() => void connect()}>
            {mcp?.connected ? "Reconnect" : "Connect"}
          </button>
          {mcp?.connected && (
            <button
              type="button"
              className="btn"
              disabled={busy}
              onClick={() => {
                setBusy(true);
                api.driveMcpClear().then(setMcp, (err: Error) => notify(err.message, true)).finally(() => setBusy(false));
              }}
            >
              Disconnect
            </button>
          )}
        </div>
      </form>
    </details>
  );
}

const BATCH_OPTIONS = [
  { value: 0, label: "Off" },
  { value: 2000, label: "2 s" },
  { value: 3000, label: "3 s" },
  { value: 5000, label: "5 s" },
];

function BatchingCard({ settings, save }: ViewProps) {
  const current = settings.debounceMs ?? 0;
  const seconds = current / 1000;
  return (
    <details className="card" open aria-label="Message batching">
      <summary className="card-title">
        <h2>Message batching</h2>
        <p className="muted small">When someone sends several messages in a row, wait a moment and hand them to the agent as one.</p>
      </summary>
      <div className="field">
        <span>Wait after the last message</span>
        <fieldset className="chips">
          <legend className="sr-only">Batching delay</legend>
          {BATCH_OPTIONS.map((o) => (
            <label key={o.value} className={`chip ${current === o.value ? "on" : ""}`}>
              <input type="radio" name="batching" checked={current === o.value} onChange={() => void save({ debounceMs: o.value }, o.value ? `Batching messages for ${o.label}` : "Batching off")} />
              {o.label}
            </label>
          ))}
        </fieldset>
        <span className="muted small">
          {current
            ? `Messages sent within ${seconds} s of each other reach the agent together, in one turn. Commands like /status still run right away.`
            : "Every message reaches the agent on its own."}
        </span>
      </div>
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
          <span className="muted small">Model · repo@branch · memory used.</span>
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
