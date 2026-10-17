import { useCallback, useEffect, useState, type ReactNode } from "react";
import { api, guestTransport, ownerTransport, type Settings } from "./api";
import { Overview } from "./views/Overview";
import { SharePanel, TeamChat } from "./views/TeamChat";
import { Schedules } from "./views/Schedules";
import { SettingsView } from "./views/Settings";

const VIEWS = [
  { id: "overview", label: "Overview", icon: <path d="M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z" /> },
  { id: "team", label: "Team chat", icon: <path d="M4 5h16v11H9l-5 4z" /> },
  { id: "schedules", label: "Schedules", icon: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></> },
  { id: "settings", label: "Settings", icon: <><path d="M4 7h10M18 7h2M4 17h4M12 17h8" /><circle cx="16" cy="7" r="2" /><circle cx="10" cy="17" r="2" /></> },
] as const;
type ViewId = (typeof VIEWS)[number]["id"];

// "#team/<thread>" deeplinks into a team thread.
const current = (): ViewId => (VIEWS.find((v) => location.hash.split("/")[0] === `#${v.id}`)?.id ?? "overview") as ViewId;
const hashThread = (): string | undefined => location.hash.split("/")[1] || undefined;

/** Public link: "/play#<token>" or "/play#<token>&thread=<id>". */
function parseGuestHash(): { token: string; thread?: string } {
  const [token = "", ...rest] = location.hash.slice(1).split("&");
  const thread = rest.find((p) => p.startsWith("thread="))?.slice("thread=".length);
  return { token, ...(thread && { thread }) };
}

/** Team chat for people with the shared link: no navigation, nothing else of the control plane. */
function GuestApp() {
  const [{ token, thread }] = useState(parseGuestHash);
  const [toast, setToast] = useState<{ text: string; error?: boolean }>();
  const notify = useCallback((text: string, error = false) => {
    setToast({ text, error });
    setTimeout(() => setToast((t) => (t?.text === text ? undefined : t)), error ? 6000 : 2500);
  }, []);
  const [transport] = useState(() => guestTransport(token));
  if (!token) return <p className="empty">This link is incomplete. Ask for a new team chat link.</p>;
  const base = `${location.origin}/play#${token}`;
  return (
    <>
      <TeamChat transport={transport} initialThread={thread} linkFor={(id) => `${base}&thread=${id}`} notify={notify} />
      {toast && <div className={`toast ${toast.error ? "error" : ""}`} role="status">{toast.text}</div>}
    </>
  );
}

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
  return location.pathname.startsWith("/play") ? <GuestApp /> : <OwnerApp />;
}

function OwnerApp() {
  const [view, setView] = useState<ViewId>(current);
  const [shareLink, setShareLink] = useState<string>();
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
    api.share().then((r) => setShareLink(r.link), () => {});
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
          <span className="brand-mark" aria-hidden="true">
            <svg viewBox="0 0 32 32" width="36" height="36">
              
              <path d="M9 9 L16 16 L23 9 M16 16 L16 24" stroke="#9ca3af" strokeWidth="2" strokeLinecap="round" fill="none" />
              <circle cx="9" cy="9" r="3.2" fill="#00f0ff" />
              <circle cx="23" cy="9" r="3.2" fill="#7107e7" />
              <circle cx="16" cy="24" r="3.2" fill="#f59e0b" />
              <circle cx="16" cy="16" r="3.6" fill="#16a34a" />
            </svg>
          </span>
          <span className="brand-text">
            <strong>Switchboard</strong>
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
        {props && view === "team" && (
          <TeamChat
            transport={ownerTransport}
            initialThread={hashThread()}
            linkFor={shareLink ? (id) => `${shareLink}&thread=${id}` : undefined}
            notify={notify}
            shareSlot={<SharePanel link={shareLink} setLink={setShareLink} notify={notify} />}
            repos={Object.entries(settings.repos).map(([name, r]) => ({ name, ...(r.base && { base: r.base }) }))}
          />
        )}
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
