import { useCallback, useEffect, useState, type ReactNode } from "react";
import { api, type Settings } from "./api";
import { Overview } from "./views/Overview";
import { Playground } from "./views/Playground";
import { Schedules } from "./views/Schedules";
import { SettingsView } from "./views/Settings";

const VIEWS = [
  { id: "overview", label: "Overview", icon: <path d="M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z" /> },
  { id: "playground", label: "Playground", icon: <path d="M4 5h16v11H9l-5 4z" /> },
  { id: "schedules", label: "Schedules", icon: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></> },
  { id: "settings", label: "Settings", icon: <><path d="M4 7h10M18 7h2M4 17h4M12 17h8" /><circle cx="16" cy="7" r="2" /><circle cx="10" cy="17" r="2" /></> },
] as const;
type ViewId = (typeof VIEWS)[number]["id"];

const current = (): ViewId => (VIEWS.find((v) => `#${v.id}` === location.hash)?.id ?? "overview") as ViewId;

export function Icon({ children, size = 16 }: { children: ReactNode; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {children}
    </svg>
  );
}

export interface ViewProps {
  settings: Settings;
  save: (patch: Partial<Settings>, ok?: string) => Promise<void>;
  setSettings: (s: Settings) => void;
  notify: (text: string, error?: boolean) => void;
}

export function App() {
  const [view, setView] = useState<ViewId>(current);
  const [settings, setSettings] = useState<Settings>();
  const [toast, setToast] = useState<{ text: string; error?: boolean }>();

  const notify = useCallback((text: string, error = false) => {
    setToast({ text, error });
    setTimeout(() => setToast((t) => (t?.text === text ? undefined : t)), error ? 6000 : 2500);
  }, []);

  useEffect(() => {
    const onHash = () => setView(current());
    addEventListener("hashchange", onHash);
    api.settings().then(setSettings, (e: Error) => notify(e.message, true));
    return () => removeEventListener("hashchange", onHash);
  }, [notify]);

  const save = useCallback(
    async (patch: Partial<Settings>, ok = "Saved") => {
      try {
        setSettings(await api.save(patch));
        notify(ok);
      } catch (err) {
        notify(err instanceof Error ? err.message : String(err), true);
      }
    },
    [notify],
  );

  const model = settings?.models[settings.agentDriver];
  const props = settings && { settings, save, setSettings, notify };

  return (
    <div className="shell">
      <nav className="sidebar" aria-label="Control plane">
        <div className="brand">
          <span className="brand-mark">
            <Icon size={18}>
              <path d="M4 6h16v10H8l-4 4z" />
              <path d="M9 11h6" />
            </Icon>
          </span>
          <span className="brand-text">
            <strong>gchat-agents</strong>
            <small>this machine</small>
          </span>
        </div>
        <div className="nav">
          {VIEWS.map((v) => (
            <a key={v.id} href={`#${v.id}`} className={view === v.id ? "active" : ""} aria-current={view === v.id ? "page" : undefined}>
              <Icon>{v.icon}</Icon>
              {v.label}
            </a>
          ))}
        </div>
        {settings && (
          <div className="agent-card">
            <small>Agent</small>
            <span>{settings.agentDriver === "claude" ? "Claude Code" : "OpenCode"}</span>
            <code>{model ?? "default model"}</code>
          </div>
        )}
      </nav>
      <main className="content">
        {!props && <div className="skeleton" aria-busy="true" />}
        {props && view === "overview" && <Overview {...props} />}
        {props && view === "playground" && <Playground {...props} />}
        {props && view === "schedules" && <Schedules {...props} />}
        {props && view === "settings" && <SettingsView {...props} />}
      </main>
      {toast && (
        <div className={`toast ${toast.error ? "error" : ""}`} role="status">
          {toast.text}
        </div>
      )}
    </div>
  );
}
