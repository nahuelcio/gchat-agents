import { useEffect, useState, type FocusEvent, type ReactNode } from "react";
import {
  ago,
  api,
  type AdoRepo,
  type AdoStatus,
  type Agent,
  type CatalogMcp,
  type ContextFooter,
  type DriveMcpStatus,
  type RepoConfig,
  type Settings,
  type McpProbe,
  type PiListing,
  type PiPackage,
  type McpServer,
  type PiCustomProvider,
  type PiKey,
  type ApprovalMode,
  type TunnelMode,
} from "../api";
import { ModelPicker } from "../ModelPicker";
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

const APPROVAL_OPTIONS: { value: ApprovalMode; label: string; hint: string }[] = [
  { value: "risky", label: "Risky actions", hint: "Ask before git push, rm -rf, DROP TABLE, kubectl apply, deploys and MCP tools that delete, merge or send." },
  { value: "writes", label: "Risky + file writes", hint: "Also ask before every file write or edit." },
  { value: "off", label: "Off", hint: "Agents act without asking. Only for machines and people you fully trust." },
];

const TABS = [
  { id: "runtime", label: "Runtime", hint: "Default Pi model and provider keys." },
  { id: "tools", label: "Tools", hint: "Custom MCP servers for agents and skill packs." },
  { id: "chat", label: "Chat", hint: "How replies are batched and how context shows up." },
  { id: "safety", label: "Safety", hint: "Approvals, spend limits and who can use the app." },
  { id: "automation", label: "Automation", hint: "Multi-agent flows, event triggers and project docs." },
  { id: "connections", label: "Connections", hint: "Tunnel, Google Chat, Drive / Calendar / Gmail, and Azure DevOps repos." },
] as const;

type TabId = (typeof TABS)[number]["id"];

const tabFromHash = (): TabId => {
  const sub = location.hash.split("/")[1];
  // Legacy #settings/agents → runtime (agents moved to Create).
  if (sub === "agents") return "runtime";
  return (TABS.find((t) => t.id === sub)?.id ?? "runtime") as TabId;
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
      {tab === "runtime" && <AgentCard {...props} />}
      {tab === "tools" && <McpServersCard {...props} />}
      {tab === "tools" && <McpCatalogCard {...props} />}
      {tab === "tools" && <PiPackagesCard {...props} />}
      {tab === "chat" && (
        <>
          <BatchingCard {...props} />
          <RoomRepliesCard {...props} />
          <ContextCard {...props} />
        </>
      )}
      {tab === "safety" && (
        <>
          <ApprovalsCard {...props} />
          <SpendCard {...props} />
          <UsersCard />
        </>
      )}
      {tab === "automation" && (
        <>
          <FlowsCard {...props} />
          <TriggersCard {...props} />
          <DocsCard />
        </>
      )}
      {tab === "connections" && (
        <>
          <TunnelCard {...props} />
          <GoogleChatCard {...props} />
          <SpacesCard {...props} />
          <DriveCard {...props} />
          <GoogleWorkspaceMcpCard
            title="Google Calendar"
            blurb={
              <>
                Agendas and reminders via{" "}
                <a href="https://developers.google.com/workspace/calendar/api/guides/configure-mcp-server" target="_blank" rel="noreferrer">
                  Google&apos;s Calendar MCP
                </a>
                . Enable Calendar API + Calendar MCP in your Cloud project, then connect. Add the{" "}
                <code>google-calendar</code> tool group to an agent in Create.
              </>
            }
            load={api.calendarMcp}
            save={api.calendarMcpSave}
            start={api.calendarMcpStart}
            clear={api.calendarMcpClear}
            notify={props.notify}
          />
          <GoogleWorkspaceMcpCard
            title="Gmail"
            blurb={
              <>
                Drafts and follow-up via{" "}
                <a href="https://developers.google.com/workspace/gmail/api/guides/configure-mcp-server" target="_blank" rel="noreferrer">
                  Google&apos;s Gmail MCP
                </a>
                . Enable Gmail API + Gmail MCP, then connect. Add the <code>google-gmail</code> tool group to an agent in Create.
              </>
            }
            load={api.gmailMcp}
            save={api.gmailMcpSave}
            start={api.gmailMcpStart}
            clear={api.gmailMcpClear}
            notify={props.notify}
          />
          <ReposCard {...props} />
        </>
      )}
    </>
  );
}

function AgentCard({ settings, save, notify }: ViewProps) {
  const [pi, setPi] = useState<Agent>();
  const [model, setModel] = useState(settings.models.pi ?? "");
  const [effort, setEffort] = useState(settings.effort ?? "high");

  useEffect(() => {
    api.agents().then(
      (list) => setPi(list.find((a) => a.id === "pi")),
      () => setPi(undefined),
    );
  }, []);
  useEffect(() => {
    setModel(settings.models.pi ?? "");
    setEffort(settings.effort ?? "high");
  }, [settings.models.pi, settings.effort]);

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
          <span>Default model</span>
          <input
            className="mono"
            value={model}
            onChange={(e) => setModel(e.target.value)}
            placeholder="provider/model, e.g. anthropic/claude-sonnet-5-5 — needs that provider's API key"
          />
          <ModelPicker
            value={model}
            onPick={(m) => {
              setModel(m);
              void save({ models: { pi: m } }, `Default model: ${m}`);
            }}
          />
          <span className="muted small">Threads can override the model with /model.</span>
          <span>Effort</span>
          <select
            value={effort}
            aria-label="Effort"
            onChange={(e) => {
              const next = e.target.value;
              setEffort(next);
              void save({ effort: next }, `Effort: ${next}`);
            }}
          >
            <option value="off">Off</option>
            <option value="minimal">Minimal</option>
            <option value="low">Low</option>
            <option value="medium">Medium</option>
            <option value="high">High</option>
            <option value="xhigh">Extra high</option>
            <option value="max">Max</option>
          </select>
          <span className="muted small">Applies on the next turn for every model and provider. A model that lists levels uses the closest one.</span>
        </div>
        <button className="btn primary">Save</button>
      </form>
      <PiKeys notify={notify} />
      <PiCustomProviders notify={notify} />
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
  const [health, setHealth] = useState<Record<string, McpProbe | "checking">>({});
  const check = (name: string) => {
    setHealth((h) => ({ ...h, [name]: "checking" }));
    void api.checkMcp(name).then(
      (p) => setHealth((h) => ({ ...h, [name]: p })),
      (e: Error) => setHealth((h) => ({ ...h, [name]: { name, ok: false, tools: [], error: e.message, ms: 0 } })),
    );
  };
  return (
    <details className="card" open aria-label="MCP servers">
      <summary className="card-title">
        <h2>MCP servers</h2>
        <p className="muted small">
          Bring any MCP server (stdio). Paste a Claude or Cursor mcp.json, or add one by hand. Its tools show up as name__tool for the agents you allow, on every runtime.{" "}
          <code>engram</code>, <code>context7</code>, <code>playwright</code> and <code>exa</code> register automatically when available (remove any here to opt out). More are ready to add in the MCP catalog below.
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
      {servers.length > 0 && (
        <div className="row">
          <button type="button" className="btn small" onClick={() => servers.forEach((m) => check(m.name))}>
            Check all
          </button>
          <span className="muted small">Starts each server and lists its tools. The first run of npx/uvx servers can take a minute.</span>
        </div>
      )}
      {servers.map((m) => {
        const h = health[m.name];
        return (
        <div key={m.name} className="persona-row">
          <div className="grow">
            <span className="strong">{m.name}</span>{" "}
            {h === "checking" && <span className="pill">checking…</span>}
            {h && h !== "checking" && (
              <span className={`pill ${h.ok ? "ok" : "bad"}`} title={h.ok ? h.tools.join(", ") : h.error}>
                {h.ok ? `ok · ${h.tools.length} tools · ${(h.ms / 1000).toFixed(1)} s` : "failing"}
              </span>
            )}{" "}
            <code className="muted small">{[m.command, ...m.args].join(" ")}</code>
            {m.env && Object.keys(m.env).length > 0 && <div className="muted small">env: {Object.keys(m.env).join(", ")}</div>}
            {h && h !== "checking" && !h.ok && <div className="small mcp-error">{h.error}</div>}
          </div>
          <button type="button" className="btn small" disabled={h === "checking"} onClick={() => check(m.name)}>
            Check
          </button>
          <button className="x" aria-label={`Remove MCP ${m.name}`} onClick={() => void commit(servers.filter((x) => x.name !== m.name), `${m.name} removed`)}>
            ×
          </button>
        </div>
        );
      })}
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

const PI_TOPICS = ["web search", "browser", "mcp", "subagents", "git", "memory", "review", "docs", "test", "plan", "image"];

const PI_RECOMMENDED = {
  name: "@earendil-works/pi-claude-code",
  spec: "https://github.com/earendil-works/pi-claude-code",
  description: "Claude Pro or Max subscription as a model provider. Sign in with claude auth login; no API key.",
  repository: "https://github.com/earendil-works/pi-claude-code",
};

function downloads(n?: number) {
  if (!n) return "";
  return n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M/mo` : n >= 1000 ? `${Math.round(n / 1000)}k/mo` : `${n}/mo`;
}

function PiMarketplace({ installed, busy, onInstall }: { installed: Set<string>; busy: string | null; onInstall: (name: string) => void }) {
  const [q, setQ] = useState("");
  const [query, setQuery] = useState("");
  const [items, setItems] = useState<PiListing[]>();
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  useEffect(() => {
    let live = true;
    setLoading(true);
    setError(undefined);
    api
      .piSearch(query)
      .then(
        (r) => {
          if (!live) return;
          setItems(r.items);
          setTotal(r.total);
        },
        (e: Error) => live && setError(e.message),
      )
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [query]);
  const more = () => {
    setLoading(true);
    void api
      .piSearch(query, items?.length ?? 0)
      .then((r) => setItems((prev) => [...(prev ?? []), ...r.items]), (e: Error) => setError(e.message))
      .finally(() => setLoading(false));
  };
  return (
    <section className="pi-market" aria-label="pi.dev marketplace">
      <form
        className="row"
        onSubmit={(e) => {
          e.preventDefault();
          setQuery(q.trim());
        }}
      >
        <input className="grow" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search pi packages" aria-label="Search pi packages" />
        <button className="btn">Search</button>
      </form>
      <div className="chips">
        {PI_TOPICS.map((t) => (
          <button
            key={t}
            type="button"
            className={`chip ${query === t ? "on" : ""}`}
            aria-pressed={query === t}
            onClick={() => {
              const next = query === t ? "" : t;
              setQ(next);
              setQuery(next);
            }}
          >
            {t}
          </button>
        ))}
      </div>
      {error && <p className="small mcp-error">{error}</p>}
      {items && <p className="muted small">{query ? `Results for “${query}”, ` : "From pi.dev, "}most popular first. Tools and model providers work here; packages that are just TUI themes or commands load with nothing to use.</p>}
      <div className="pi-grid">
        {(!query || /claude/i.test(query)) && (
          <article className="pi-item" aria-label="Recommended package">
            <div className="pi-item-head">
              <a className="strong" href={PI_RECOMMENDED.repository} target="_blank" rel="noreferrer">
                {PI_RECOMMENDED.name}
              </a>
              <span className="pill accent">Recommended</span>
            </div>
            <p className="small pi-desc">{PI_RECOMMENDED.description}</p>
            <div className="pi-item-foot">
              <span className="muted small">GitHub · model provider</span>
              <a className="small" href={PI_RECOMMENDED.repository} target="_blank" rel="noreferrer">
                source
              </a>
              <button type="button" className={`btn small ${installed.has(PI_RECOMMENDED.name) ? "" : "primary"}`} disabled={installed.has(PI_RECOMMENDED.name) || busy !== null} onClick={() => onInstall(PI_RECOMMENDED.spec)}>
                {installed.has(PI_RECOMMENDED.name) ? "Installed" : busy === PI_RECOMMENDED.spec ? "Installing…" : "Install"}
              </button>
            </div>
          </article>
        )}
        {items && [...items].sort((a, b) => Number(installed.has(b.name)) - Number(installed.has(a.name))).map((p) => {
          const have = installed.has(p.name);
          return (
            <article key={p.name} className="pi-item">
              <div className="pi-item-head">
                <a className="strong" href={p.npm ?? `https://www.npmjs.com/package/${p.name}`} target="_blank" rel="noreferrer">
                  {p.name}
                </a>
                <span className="muted small">v{p.version}</span>
              </div>
              <p className="small pi-desc">{p.description || "No description."}</p>
              <div className="pi-item-foot">
                <span className="muted small">
                  {[downloads(p.monthly), p.publisher, p.updated && ago(p.updated)].filter(Boolean).join(" · ")}
                </span>
                {p.repository && (
                  <a className="small" href={p.repository} target="_blank" rel="noreferrer">
                    source
                  </a>
                )}
                <button type="button" className={`btn small ${have ? "" : "primary"}`} disabled={have || busy !== null} onClick={() => onInstall(p.name)}>
                  {have ? "Installed" : busy === p.name ? "Installing…" : "Install"}
                </button>
              </div>
            </article>
          );
        })}
      </div>
      {loading && <p className="muted small">Loading…</p>}
      {items && items.length < total && !loading && (
        <button type="button" className="btn small" onClick={more}>
          Show more
        </button>
      )}
    </section>
  );
}

function PiPackagesCard({ notify }: ViewProps) {
  const [list, setList] = useState<PiPackage[]>();
  const [spec, setSpec] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  useEffect(() => {
    api.piPackages().then(setList, () => setList([]));
  }, []);
  const run = (label: string, p: Promise<PiPackage[]>, ok: string) => {
    setBusy(label);
    void p
      .then(
        (next) => {
          setList(next);
          notify(ok);
        },
        (e: Error) => notify(e.message, true),
      )
      .finally(() => setBusy(null));
  };
  return (
    <details className="card" open aria-label="pi.dev packages">
      <summary className="card-title">
        <h2>pi.dev packages</h2>
        <p className="muted small">
          Install extensions from <a href="https://pi.dev/packages" target="_blank" rel="noreferrer">pi.dev/packages</a> or a GitHub repo. Their tools become a tool group (pi-…) you can give to agents, bundled skills land in your skills, a model provider shows up in the model picker, and commands show up in the chat / menu. UI hooks run when a turn finishes.
        </p>
      </summary>
      <form
        className="row"
        onSubmit={(e) => {
          e.preventDefault();
          if (spec.trim()) run("install", api.installPiPackage(spec.trim()), `${spec.trim()} installed`);
        }}
      >
        <input className="mono grow" value={spec} onChange={(e) => setSpec(e.target.value)} placeholder="npm package or https://github.com/owner/repo" aria-label="Package" />
        <button className="btn primary" disabled={!spec.trim() || busy !== null}>
          {busy === "install" ? "Installing…" : "Install"}
        </button>
      </form>
      {!!list?.length && <h3 className="pi-installed-title">Installed ({list.length})</h3>}
      {list?.map((p) => (
        <div key={p.name} className="persona-row">
          <div className="grow">
            <span className="strong">{p.name}</span> <code className="muted small">{p.group}</code>{" "}
            {p.name === PI_RECOMMENDED.name && <span className="pill accent">Recommended</span>}{" "}
            {p.error ? (
              <span className="pill bad">failing</span>
            ) : (
              <>
                {(p.tools.length > 0 || p.providers.length === 0) && <span className="pill ok">{p.tools.length} tools</span>}
                {p.providers.length > 0 && <span className="pill ok">{p.providers.length === 1 ? "1 provider" : `${p.providers.length} providers`}</span>}
              </>
            )}
            {p.tools.length > 0 && <div className="muted small">tools: {p.tools.join(", ")}</div>}
            {p.providers.length > 0 && <div className="muted small">models: {p.providers.flatMap((provider) => provider.models).join(", ")}</div>}
            {p.providers.some((provider) => provider.error) && <div className="small mcp-error">{p.providers.flatMap((provider) => (provider.error ? [provider.error] : [])).join(" ")}</div>}
            {p.skills.length > 0 && <div className="muted small">skills: {p.skills.join(", ")}</div>}
            {!!p.commands?.length && <div className="muted small">commands: {p.commands.map((c) => `/${c.name}`).join(", ")}</div>}
            {!!p.uiHooks?.length && <div className="muted small">hooks: {p.uiHooks.join(", ")}</div>}
            {p.ignored.length > 0 && <div className="muted small">ignored: {p.ignored.join(", ")}</div>}
            {p.error && <div className="small mcp-error">{p.error}</div>}
          </div>
          <button type="button" className="x" aria-label={`Remove ${p.name}`} disabled={busy !== null} onClick={() => run(p.name, api.removePiPackage(p.name), `${p.name} removed`)}>
            ×
          </button>
        </div>
      ))}
      <h3 className="pi-installed-title">Browse</h3>
      <PiMarketplace installed={new Set((list ?? []).map((p) => p.name))} busy={busy} onInstall={(name) => run(name, api.installPiPackage(name), `${name} installed`)} />
    </details>
  );
}

function McpCatalogCard({ settings, setSettings, notify }: ViewProps) {
  const [catalog, setCatalog] = useState<CatalogMcp[]>();
  const [open, setOpen] = useState<string | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api.mcpCatalog().then(setCatalog, () => setCatalog([]));
  }, []);
  const installed = new Set((settings.mcpServers ?? []).map((m) => m.name));
  const add = (entry: CatalogMcp, vals: Record<string, string>) => {
    setBusy(true);
    api
      .addCatalogMcp(entry.name, vals)
      .then(
        (next) => {
          setSettings(next);
          setOpen(null);
          setValues({});
          notify(`${entry.title} added. Allow ${entry.name} on the agents that should use it.`);
        },
        (err: Error) => notify(err.message, true),
      )
      .finally(() => setBusy(false));
  };
  if (!catalog?.length) return null;
  return (
    <details className="card" aria-label="MCP catalog">
      <summary className="card-title">
        <h2>MCP catalog</h2>
        <p className="muted small">Optional servers ready to add. Ones that need a key or sign-in ask for it here or open a browser the first time they run.</p>
      </summary>
      {catalog.map((entry) => (
        <div key={entry.name} className="persona-row">
          <div className="grow">
            <span className="strong">{entry.title}</span> <code className="muted small">{entry.name}</code>
            <div className="muted small">
              {entry.description}
              {entry.docs && (
                <>
                  {" "}
                  <a href={entry.docs} target="_blank" rel="noreferrer">
                    Docs
                  </a>
                </>
              )}
            </div>
            {open === entry.name && (
              <form
                className="persona-form"
                aria-label={`Add ${entry.title}`}
                onSubmit={(e) => {
                  e.preventDefault();
                  add(entry, values);
                }}
              >
                {(entry.inputs ?? []).map((input) => (
                  <label key={input.key} className="field">
                    <span>{input.label}</span>
                    <input
                      className="mono"
                      type={input.secret ? "password" : "text"}
                      autoComplete="off"
                      value={values[input.key] ?? ""}
                      onChange={(e) => setValues({ ...values, [input.key]: e.target.value })}
                      required
                    />
                  </label>
                ))}
                <div className="row">
                  <button className="btn primary" disabled={busy}>
                    {busy ? "Adding…" : "Add"}
                  </button>
                  <button type="button" className="btn" onClick={() => setOpen(null)}>
                    Cancel
                  </button>
                </div>
              </form>
            )}
          </div>
          {installed.has(entry.name) ? (
            <span className="muted small">Added</span>
          ) : (
            open !== entry.name && (
              <button
                className="btn small"
                disabled={busy}
                onClick={() => {
                  if (entry.inputs?.length) {
                    setValues({});
                    setOpen(entry.name);
                  } else add(entry, {});
                }}
              >
                Add
              </button>
            )
          )}
        </div>
      ))}
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
        <button className="btn add-endpoint" onClick={() => setDraft({ ...EMPTY_CUSTOM })}>
          + Add OpenAI-compatible endpoint
        </button>
      )}
      <button
        type="button"
        className="btn"
        onClick={() =>
          void api.importTokenBank().then(
            (next) => {
              setList(next);
              notify("TokenBank imported");
            },
            (e: Error) => notify(e.message, true),
          )
        }
      >
        Import from ywai TokenBank
      </button>
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

function GoogleWorkspaceMcpCard({
  title,
  blurb,
  load,
  save,
  start,
  clear,
  notify,
}: {
  title: string;
  blurb: ReactNode;
  load: () => Promise<DriveMcpStatus>;
  save: (clientId: string, clientSecret: string) => Promise<DriveMcpStatus>;
  start: () => Promise<{ url: string }>;
  clear: () => Promise<DriveMcpStatus>;
  notify: ViewProps["notify"];
}) {
  const [mcp, setMcp] = useState<DriveMcpStatus>();
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    load().then((status) => {
      setMcp(status);
      setClientId(status.clientId ?? "");
    }, () => {});
  }, [load]);

  async function connect() {
    setBusy(true);
    try {
      const { url } = await start();
      window.open(url, "_blank", "noopener");
      for (let i = 0; i < 60; i++) {
        await new Promise((r) => setTimeout(r, 2000));
        const next = await load();
        setMcp(next);
        if (next.connected) {
          notify(`${title} connected`);
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
    <details className="card" open aria-label={title}>
      <summary className="card-title">
        <h2>{title}</h2>
        <p className="muted small">{blurb}</p>
      </summary>
      <form
        className="field"
        onSubmit={(e) => {
          e.preventDefault();
          setBusy(true);
          save(clientId.trim(), clientSecret)
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
        <input
          className="mono"
          type="password"
          value={clientSecret}
          onChange={(e) => setClientSecret(e.target.value)}
          placeholder={mcp?.configured ? "Client secret saved — paste a new one to replace it" : "Client secret"}
          autoComplete="off"
        />
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
                clear().then(setMcp, (err: Error) => notify(err.message, true)).finally(() => setBusy(false));
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
  const current = settings.debounceMs ?? 3000;
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

function RoomRepliesCard({ settings, save }: ViewProps) {
  const parallel = settings.parallelRoom ?? true;
  const options = [
    { value: true, label: "Parallel" },
    { value: false, label: "After the host" },
  ];
  return (
    <details className="card" open aria-label="Room replies">
      <summary className="card-title">
        <h2>Room replies</h2>
        <p className="muted small">When a message isn't addressed to anyone, the other agents in the room may chime in.</p>
      </summary>
      <div className="field">
        <span>Other agents answer</span>
        <fieldset className="chips">
          <legend className="sr-only">When the other agents answer</legend>
          {options.map((o) => (
            <label key={o.label} className={`chip ${parallel === o.value ? "on" : ""}`}>
              <input type="radio" name="room-replies" checked={parallel === o.value} onChange={() => void save({ parallelRoom: o.value }, `Room replies: ${o.label.toLowerCase()}`)} />
              {o.label}
            </label>
          ))}
        </fieldset>
        <span className="muted small">
          {parallel
            ? "Everyone starts at once and each reply shows up as soon as it's ready. Faster, but agents don't see the host's answer first."
            : "Agents wait for the host to finish and read its answer before deciding to chime in."}
        </span>
      </div>
    </details>
  );
}

function ApprovalsCard({ settings, save }: ViewProps) {
  const current = APPROVAL_OPTIONS.find((o) => o.value === settings.approvals) ?? APPROVAL_OPTIONS[0];
  return (
    <details className="card" open>
      <summary className="card-title">
        <h2>Approvals</h2>
        <p className="muted small">Before a risky action the agent pauses and posts Approve / Deny buttons in the thread. Unanswered requests are denied after 10 minutes.</p>
      </summary>
      <div className="field">
        <span>Ask before</span>
        <fieldset className="chips">
          <legend className="sr-only">Approval mode</legend>
          {APPROVAL_OPTIONS.map((o) => (
            <label key={o.value} className={`chip ${current.value === o.value ? "on" : ""}`} title={o.hint}>
              <input type="radio" name="approvals" checked={current.value === o.value} onChange={() => void save({ approvals: o.value }, `Approvals: ${o.label}`)} />
              {o.label}
            </label>
          ))}
        </fieldset>
        <span className="muted small">{current.hint}</span>
      </div>
      <p className="muted small">Overrides win over the global level: an agent override first, then the repo, then this setting.</p>
      {settings.personas.map((p) => (
        <label key={p.name} className="field">
          <span>@{p.name}</span>
          <select
            value={settings.agentApprovals?.[p.name] ?? ""}
            onChange={(e) => {
              const agentApprovals = { ...settings.agentApprovals };
              if (!e.target.value) delete agentApprovals[p.name];
              else agentApprovals[p.name] = e.target.value as ApprovalMode;
              void save({ agentApprovals }, `@${p.name} approvals`);
            }}
          >
            <option value="">Use global</option>
            {APPROVAL_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </label>
      ))}
      {Object.keys(settings.repos).map((repo) => (
        <label key={repo} className="field">
          <span>{repo}</span>
          <select
            value={settings.repoApprovals?.[repo] ?? ""}
            onChange={(e) => {
              const repoApprovals = { ...settings.repoApprovals };
              if (!e.target.value) delete repoApprovals[repo];
              else repoApprovals[repo] = e.target.value as ApprovalMode;
              void save({ repoApprovals }, `${repo} approvals`);
            }}
          >
            <option value="">Use global</option>
            {APPROVAL_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </label>
      ))}
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
  const [orgDraft, setOrgDraft] = useState("");
  const [patDraft, setPatDraft] = useState("");
  const [projectDraft, setProjectDraft] = useState("");
  const [busyKey, setBusyKey] = useState(false);

  function applyAdo(s: AdoStatus) {
    setAdo(s);
    if (!s.connected) {
      setProjects([]);
      setProject("");
      return;
    }
    setOrgDraft(s.org);
    setProjectDraft(s.defaultProject ?? "");
    api.adoProjects().then((list) => {
      setProjects(list.map((p) => p.name));
      const match = list.find((p) => p.name.toLowerCase() === s.defaultProject?.toLowerCase());
      if (match) setProject(match.name);
    }, () => {});
  }

  useEffect(() => {
    api.adoStatus().then(applyAdo, () => setAdo({ connected: false }));
  }, []);
  useEffect(() => {
    setRepos([]);
    setRepo("");
    if (project) api.adoRepos(project).then(setRepos, () => {});
  }, [project]);

  const entries = Object.entries(settings.repos);
  const hasEnvPat = !!ado?.hasEnvPat;
  const sourceLabel =
    ado?.connected && ado.source === "settings"
      ? "saved in Switchboard"
      : ado?.connected && ado.source === "env"
        ? "AZURE_DEVOPS_PAT from environment"
        : ado?.connected
          ? "from ado CLI / env"
          : null;
  const patOptional =
    hasEnvPat || (ado?.connected === true && (ado.source === "settings" || ado.source === "env"));

  return (
    <details className="card" open>
      <summary className="card-title">
        <h2>Repos</h2>
        <p className="muted small">
          {ado?.connected
            ? `Azure DevOps · ${ado.org}${sourceLabel ? ` (${sourceLabel})` : ""}.`
            : ado
              ? hasEnvPat
                ? "AZURE_DEVOPS_PAT is set — enter org (and optional project) to connect."
                : "Paste your org and PAT below to enable clones and the ado CLI for agents."
              : " "}
        </p>
      </summary>
      <form
        className="field"
        onSubmit={(e) => {
          e.preventDefault();
          setBusyKey(true);
          api
            .adoSave(orgDraft.trim(), patDraft, projectDraft.trim() || undefined)
            .then((s) => {
              setPatDraft("");
              applyAdo(s);
              notify("Azure DevOps credentials saved");
            }, (err: Error) => notify(err.message, true))
            .finally(() => setBusyKey(false));
        }}
      >
        <span>Azure DevOps</span>
        <input
          className="mono"
          value={orgDraft}
          onChange={(e) => setOrgDraft(e.target.value)}
          placeholder="Organization (dev.azure.com/ORG → ORG)"
          autoComplete="off"
          required
        />
        <input
          className="mono"
          type="password"
          value={patDraft}
          onChange={(e) => setPatDraft(e.target.value)}
          placeholder={
            hasEnvPat
              ? "AZURE_DEVOPS_PAT in env — leave blank to use it, or paste to override"
              : ado?.connected && ado.source === "settings"
                ? "PAT saved — paste a new one to replace it"
                : "Personal access token (Code Read)"
          }
          autoComplete="off"
          required={!patOptional}
        />
        <input
          className="mono"
          value={projectDraft}
          onChange={(e) => setProjectDraft(e.target.value)}
          placeholder="Default project (optional)"
          autoComplete="off"
        />
        <div className="row">
          <button className="btn primary" disabled={busyKey || !orgDraft.trim()}>
            {busyKey ? "Saving…" : "Save key"}
          </button>
          {ado?.connected && (ado.source === "settings" || ado.source === "env") && (
            <button
              type="button"
              className="btn"
              disabled={busyKey}
              onClick={() => {
                setBusyKey(true);
                api
                  .adoClear()
                  .then((s) => {
                    setOrgDraft(s.connected ? s.org : "");
                    setProjectDraft(s.connected ? (s.defaultProject ?? "") : "");
                    applyAdo(s);
                    notify("Switchboard Azure credentials cleared");
                  }, (err: Error) => notify(err.message, true))
                  .finally(() => setBusyKey(false));
              }}
            >
              Clear saved key
            </button>
          )}
        </div>
        <span className="muted small">
          Create a PAT in Azure DevOps → User settings → Personal access tokens (Code Read &amp; Write; Work Items Read for board recipes).
          If <code>AZURE_DEVOPS_PAT</code> is already in the environment, Settings reads it automatically.
          Saving installs the shared <code>ado</code> profile so agents can run <code>ado wi list</code>.
        </span>
      </form>
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

function capField(label: string, value: number | undefined, onChange: (n?: number) => void) {
  return (
    <label className="field">
      <span>{label}</span>
      <input type="number" min={0} step="0.01" value={value ?? ""} placeholder="No cap" onChange={(e) => onChange(e.target.value === "" ? undefined : Number(e.target.value))} />
    </label>
  );
}

function SpendCard({ settings, save }: ViewProps) {
  const spend = settings.spend ?? {};
  const set = (patch: Partial<NonNullable<Settings["spend"]>>) => void save({ spend: { ...spend, ...patch } }, "Spend caps saved");
  return (
    <details className="card" open>
      <summary className="card-title"><h2>Spend caps</h2><p className="muted small">Warn at 80% of today's cap and stop at 100%. /spend-continue lets that thread go on.</p></summary>
      {capField("Per day (USD)", spend.dailyUsd, (dailyUsd) => set({ dailyUsd }))}
      {capField("Per agent today (USD)", spend.perAgentUsd, (perAgentUsd) => set({ perAgentUsd }))}
      {capField("Per thread today (USD)", spend.perThreadUsd, (perThreadUsd) => set({ perThreadUsd }))}
    </details>
  );
}

function FlowsCard({ settings, save }: ViewProps) {
  const flows = settings.flows ?? [];
  const agents = (settings.personas ?? []).map((p) => p.name);
  const [name, setName] = useState("");
  const [steps, setSteps] = useState<{ agent: string; approve: boolean }[]>([]);
  const setStep = (i: number, patch: Partial<{ agent: string; approve: boolean }>) =>
    setSteps((list) => list.map((s, j) => (j === i ? { ...s, ...patch } : s)));
  const id = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return (
    <details className="card" open>
      <summary className="card-title">
        <h2>Flows</h2>
        <p className="muted small">A chain of agents that pass the work along, one after the other. Run it in a thread with <code>/flow name</code>.</p>
      </summary>
      {flows.length === 0 ? (
        <p className="muted small">No flows yet.</p>
      ) : (
        <ul className="auto-list">
          {flows.map((f) => (
            <li key={f.id}>
              <div className="grow">
                <strong>{f.name}</strong> <code className="small">/flow {f.id}</code>
                <div className="chips">
                  {f.steps.map((s, i) => (
                    <span key={i} className="pill">{i + 1}. {s.agent}{s.approve ? " · asks first" : ""}</span>
                  ))}
                </div>
              </div>
              <button type="button" className="btn small ghost" onClick={() => void save({ flows: flows.filter((x) => x.id !== f.id) }, "Flow removed")}>Remove</button>
            </li>
          ))}
        </ul>
      )}
      <form
        className="auto-form"
        onSubmit={(e) => {
          e.preventDefault();
          void save({ flows: [...flows.filter((f) => f.id !== id), { id, name, steps }] }, "Flow saved").then(() => {
            setName("");
            setSteps([]);
          });
        }}
      >
        <h3>New flow</h3>
        <label className="field">
          <span>Name</span>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Feature end to end" required />
        </label>
        <div className="field">
          <span>Steps</span>
          {steps.map((s, i) => (
            <div key={i} className="row auto-step">
              <span className="muted">{i + 1}.</span>
              <select value={s.agent} onChange={(e) => setStep(i, { agent: e.target.value })}>
                {agents.map((a) => <option key={a} value={a}>{a}</option>)}
              </select>
              <label className="row small">
                <input type="checkbox" checked={s.approve} onChange={(e) => setStep(i, { approve: e.target.checked })} />
                Wait for my OK before this step
              </label>
              <button type="button" className="btn small ghost" onClick={() => setSteps((list) => list.filter((_, j) => j !== i))}>Remove</button>
            </div>
          ))}
          <div>
            <button type="button" className="btn small" disabled={agents.length === 0} onClick={() => setSteps((list) => [...list, { agent: agents[0], approve: false }])}>+ Add step</button>
          </div>
        </div>
        <div className="row">
          <button className="btn primary" type="submit" disabled={!id || steps.length === 0}>Save flow</button>
        </div>
      </form>
    </details>
  );
}

function UsersCard() {
  const [users, setUsers] = useState<{ name: string; role: string }[]>([]);
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState("operator");
  const [error, setError] = useState("");
  const load = () => api.users().then((r) => setUsers(r.users), (e: Error) => setError(e.message));
  useEffect(() => { void load(); }, []);
  return (
    <details className="card">
      <summary className="card-title"><h2>Users</h2><p className="muted small">Empty means this machine stays open. The first user turns on sign-in for everyone, including localhost.</p></summary>
      {error && <p className="error">{error}</p>}
      <ul>{users.map((u) => <li key={u.name}>{u.name} · {u.role} <button type="button" className="btn small ghost" onClick={() => void api.removeUser(u.name).then((r) => setUsers(r.users), (e: Error) => setError(e.message))}>Remove</button></li>)}</ul>
      <form onSubmit={(e) => { e.preventDefault(); void api.addUser(name, password, role).then((r) => { setUsers(r.users); setName(""); setPassword(""); }, (err: Error) => setError(err.message)); }}>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name" required />
        <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Password (8+)" required />
        <select value={role} onChange={(e) => setRole(e.target.value)}><option value="admin">admin</option><option value="operator">operator</option><option value="guest">guest</option></select>
        <button className="btn small" type="submit">Add user</button>
      </form>
    </details>
  );
}

function TriggersCard({ settings }: ViewProps) {
  const agents = (settings.personas ?? []).map((p) => p.name);
  const [rows, setRows] = useState<{ id: string; name: string; agent: string; prompt: string; secret: string; repo?: string }[]>([]);
  const [name, setName] = useState("");
  const [agent, setAgent] = useState(agents[0] ?? "");
  const [prompt, setPrompt] = useState("");
  const [repo, setRepo] = useState("");
  const [error, setError] = useState("");
  useEffect(() => { api.triggers().then((r) => setRows(r.triggers), (e: Error) => setError(e.message)); }, []);
  const copy = (text: string) => void navigator.clipboard.writeText(text);
  return (
    <details className="card" open>
      <summary className="card-title">
        <h2>Event triggers</h2>
        <p className="muted small">Let another service start a thread. When it calls the trigger URL, the agent gets your prompt plus what the service sent.</p>
      </summary>
      {error && <p className="error">{error}</p>}
      {rows.length === 0 ? (
        <p className="muted small">No triggers yet.</p>
      ) : (
        <ul className="auto-list">
          {rows.map((t) => (
            <li key={t.id}>
              <div className="grow">
                <strong>{t.name}</strong> <span className="muted small">→ @{t.agent}{t.repo ? ` in ${t.repo}` : ""}</span>
                <div className="row small">
                  <code>/hooks/{t.id}</code>
                  <button type="button" className="btn small ghost" onClick={() => copy(`/hooks/${t.id}`)}>Copy URL</button>
                  <button type="button" className="btn small ghost" onClick={() => copy(t.secret)}>Copy secret</button>
                </div>
              </div>
              <button type="button" className="btn small ghost" onClick={() => void api.deleteTrigger(t.id).then(() => setRows((list) => list.filter((x) => x.id !== t.id)))}>Remove</button>
            </li>
          ))}
        </ul>
      )}
      <form
        className="auto-form"
        onSubmit={(e) => {
          e.preventDefault();
          void api.saveTrigger({ name, agent, prompt, repo: repo || undefined }).then(
            (saved) => {
              setRows((list) => [...list, { ...saved, name, agent, prompt, repo }]);
              setName("");
              setPrompt("");
              setRepo("");
            },
            (err: Error) => setError(err.message),
          );
        }}
      >
        <h3>New trigger</h3>
        <div className="row">
          <label className="field grow">
            <span>Name</span>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Sentry alert" required />
          </label>
          <label className="field grow">
            <span>Agent</span>
            <select value={agent} onChange={(e) => setAgent(e.target.value)} required>
              {agents.map((a) => <option key={a} value={a}>{a}</option>)}
            </select>
          </label>
          <label className="field grow">
            <span>Repo (optional)</span>
            <input value={repo} onChange={(e) => setRepo(e.target.value)} placeholder="switchboard" />
          </label>
        </div>
        <label className="field">
          <span>What should the agent do?</span>
          <textarea rows={3} value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="Investigate this alert and propose a fix." required />
        </label>
        <p className="muted small">The service signs each request with the secret: header <code>X-Switchboard-Signature: sha256=&lt;hmac of the body&gt;</code>.</p>
        <div className="row">
          <button className="btn primary" type="submit">Create trigger</button>
        </div>
      </form>
    </details>
  );
}

function DocsCard() {
  const [project, setProject] = useState("switchboard");
  const [kind, setKind] = useState("doc");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [listed, setListed] = useState("");
  const [error, setError] = useState("");
  const list = () => api.docs(project).then((r) => setListed(r.text), (err: Error) => setError(err.message));
  useEffect(() => { void list(); }, []);
  return (
    <details className="card" open>
      <summary className="card-title">
        <h2>Project docs</h2>
        <p className="muted small">Notes the agents can look up while they work: decisions (ADRs), runbooks or any other doc.</p>
      </summary>
      {error && <p className="error">{error}</p>}
      <label className="field">
        <span>Project</span>
        <input value={project} onChange={(e) => setProject(e.target.value)} onBlur={() => void list()} />
      </label>
      {listed ? <pre className="logs">{listed}</pre> : <p className="muted small">No docs in this project yet.</p>}
      <form
        className="auto-form"
        onSubmit={(e) => {
          e.preventDefault();
          void api.saveDoc(project, kind, title, body).then(() => {
            setTitle("");
            setBody("");
            return list();
          }, (err: Error) => setError(err.message));
        }}
      >
        <h3>New doc</h3>
        <div className="row">
          <label className="field grow">
            <span>Title</span>
            <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="How we deploy" required />
          </label>
          <label className="field narrow">
            <span>Type</span>
            <select value={kind} onChange={(e) => setKind(e.target.value)}>
              <option value="doc">Doc</option>
              <option value="adr">Decision (ADR)</option>
              <option value="runbook">Runbook</option>
            </select>
          </label>
        </div>
        <label className="field">
          <span>Content (Markdown)</span>
          <textarea rows={8} value={body} onChange={(e) => setBody(e.target.value)} required />
        </label>
        <div className="row">
          <button className="btn primary" type="submit">Save doc</button>
        </div>
      </form>
    </details>
  );
}
