import { lazy, Suspense, useCallback, useEffect, useState, type ReactNode } from "react";
import { api, guestTransport, ownerTransport, type Settings } from "./api";
import { SearchBox } from "./SearchBox";
import { useJobAlerts } from "./jobAlerts";

const Overview = lazy(() => import("./views/Overview").then((m) => ({ default: m.Overview })));
const TeamChat = lazy(() => import("./views/TeamChat").then((m) => ({ default: m.TeamChat })));
const SharePanel = lazy(() => import("./views/TeamChat").then((m) => ({ default: m.SharePanel })));
const Schedules = lazy(() => import("./views/Schedules").then((m) => ({ default: m.Schedules })));
const CreateView = lazy(() => import("./views/CreateWithAi").then((m) => ({ default: m.CreateView })));
const SettingsView = lazy(() => import("./views/Settings").then((m) => ({ default: m.SettingsView })));
const InsightsView = lazy(() => import("./views/Insights").then((m) => ({ default: m.InsightsView })));
const viewFallback = <div className="skeleton" aria-busy="true" />;

const VIEWS = [
  { id: "overview", label: "Overview", icon: <path d="M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z" /> },
  { id: "team", label: "Team chat", icon: <path d="M4 5h16v11H9l-5 4z" /> },
  { id: "create", label: "Agents", icon: <path d="M12 5v14M5 12h14" /> },
  { id: "insights", label: "Insights", icon: <path d="M4 20V10M10 20V4M16 20v-7M22 20H2" /> },
  { id: "schedules", label: "Schedules", icon: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></> },
  { id: "settings", label: "Settings", icon: <><path d="M4 7h10M18 7h2M4 17h4M12 17h8" /><circle cx="16" cy="7" r="2" /><circle cx="10" cy="17" r="2" /></> },
] as const;
type ViewId = (typeof VIEWS)[number]["id"];

/** "#create?starter=finanzas" or "#team/<id>" or "#settings/runtime". */
function parseOwnerHash(): { view: ViewId; path?: string; query: URLSearchParams } {
  const raw = location.hash.slice(1);
  const qIdx = raw.indexOf("?");
  const pathPart = qIdx >= 0 ? raw.slice(0, qIdx) : raw;
  const query = new URLSearchParams(qIdx >= 0 ? raw.slice(qIdx + 1) : "");
  const [viewPart = "overview", ...rest] = pathPart.split("/");
  const view = (VIEWS.find((v) => v.id === viewPart)?.id ?? "overview") as ViewId;
  const path = rest.join("/") || undefined;
  return { view, path, query };
}

const current = (): ViewId => parseOwnerHash().view;
const hashThread = (): string | undefined => {
  const h = parseOwnerHash();
  return h.view === "team" ? h.path : undefined;
};
export const hashQuery = (): URLSearchParams => parseOwnerHash().query;

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
  if (!token) {
    return (
      <div className="guest-empty">
        <img src="/brand/switchboard-icon.svg" width={48} height={48} alt="Switchboard" />
        <p className="empty">This link is incomplete. Ask for a new team chat link.</p>
      </div>
    );
  }
  const base = `${location.origin}/play#${token}`;
  const scoped = token.includes(".");
  return (
    <>
      <Suspense fallback={viewFallback}>
        <TeamChat transport={transport} initialThread={thread} linkFor={(id) => (scoped && id !== thread ? undefined : `${base}&thread=${id}`)} notify={notify} singleThread={scoped} />
      </Suspense>
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

function rememberNavOpen(): boolean {
  try {
    const raw = localStorage.getItem("switchboard.navOpen");
    return raw == null ? true : JSON.parse(raw) === true;
  } catch {
    return true;
  }
}

function OwnerApp() {
  const [view, setView] = useState<ViewId>(current);
  const [hash, setHash] = useState(location.hash);
  const [shareLink, setShareLink] = useState<string>();
  const [settings, setSettings] = useState<Settings>();
  const [toast, setToast] = useState<{ text: string; error?: boolean }>();
  const [navOpen, setNavOpen] = useState(rememberNavOpen);
  const [gate, setGate] = useState<"check" | "open" | "login">("check");
  const [loginName, setLoginName] = useState("");
  const [loginPassword, setLoginPassword] = useState("");
  const [loginError, setLoginError] = useState("");
  useJobAlerts();

  const notify = useCallback((text: string, error = false) => {
    setToast({ text, error });
    setTimeout(() => setToast((t) => (t?.text === text ? undefined : t)), error ? 6000 : 2500);
  }, []);

  function toggleNav(open: boolean) {
    setNavOpen(open);
    try {
      localStorage.setItem("switchboard.navOpen", JSON.stringify(open));
    } catch {
      // private window
    }
  }

  useEffect(() => {
    const onHash = () => {
      setView(current());
      setHash(location.hash);
    };
    addEventListener("hashchange", onHash);
    api.me().then(
      () => setGate("open"),
      (e: Error) => setGate(/sign in/i.test(e.message) ? "login" : "open"),
    );
    api.settings().then(setSettings, (e: Error) => notify(e.message, true));
    api.share().then((r) => setShareLink(r.link), () => {});
    return () => removeEventListener("hashchange", onHash);
  }, [notify]);

  useEffect(() => {
    if (gate !== "open") return;
    const onKey = (e: KeyboardEvent) => {
      const typing = e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || (e.target instanceof HTMLElement && e.target.isContentEditable);
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        dispatchEvent(new Event("switchboard:search"));
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "n") {
        e.preventDefault();
        location.hash = "#team";
        dispatchEvent(new Event("switchboard:new-thread"));
        return;
      }
      if (e.altKey && e.key === "ArrowUp") {
        e.preventDefault();
        dispatchEvent(new Event("switchboard:prev-thread"));
        return;
      }
      if (e.altKey && e.key === "ArrowDown") {
        e.preventDefault();
        dispatchEvent(new Event("switchboard:next-thread"));
        return;
      }
      if (e.key === "Escape" && !typing) dispatchEvent(new CustomEvent("switchboard:stop", { detail: e.target }));
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [gate]);

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

  if (gate === "check") return <div className="skeleton" aria-busy="true" />;
  if (gate === "login") {
    return (
      <form
        className="login-gate"
        onSubmit={(e) => {
          e.preventDefault();
          api.login(loginName, loginPassword).then(
            () => setGate("open"),
            (err: Error) => setLoginError(err.message),
          );
        }}
      >
        <h1>Switchboard</h1>
        <label>Name<input value={loginName} onChange={(e) => setLoginName(e.target.value)} autoComplete="username" /></label>
        <label>Password<input type="password" value={loginPassword} onChange={(e) => setLoginPassword(e.target.value)} autoComplete="current-password" /></label>
        {loginError && <p className="error">{loginError}</p>}
        <button className="btn primary" type="submit">Sign in</button>
      </form>
    );
  }

  const model = settings?.models.pi;
  const props = settings && { settings, save, setSettings, notify };

  return (
    <div className={`shell${navOpen ? "" : " nav-collapsed"}`}>
      <nav className={`sidebar${navOpen ? "" : " collapsed"}`} aria-label="Control plane">
        <div className="brand">
          <button
            type="button"
            className="brand-mark"
            aria-label={navOpen ? "Switchboard" : "Expand navigation"}
            title={navOpen ? "Switchboard" : "Expand navigation"}
            onClick={() => {
              if (!navOpen) toggleNav(true);
              else location.hash = "#overview";
            }}
          >
            <img src="/brand/switchboard-icon.svg" width={36} height={36} alt="" />
          </button>
          <span className="brand-text">
            <strong>Switchboard</strong>
            <small>this machine</small>
          </span>
          <button
            type="button"
            className="btn icon ghost sidebar-toggle"
            aria-label={navOpen ? "Collapse navigation" : "Expand navigation"}
            title={navOpen ? "Collapse navigation" : "Expand navigation"}
            aria-pressed={!navOpen}
            onClick={() => toggleNav(!navOpen)}
          >
            <Icon size={16}>{navOpen ? <path d="M15 18l-6-6 6-6" /> : <path d="M9 18l6-6-6-6" />}</Icon>
          </button>
        </div>
        {navOpen && <SearchBox />}
        <div className="nav">
          {VIEWS.map((v) => (
            <a
              key={v.id}
              href={`#${v.id}`}
              className={view === v.id ? "active" : ""}
              aria-current={view === v.id ? "page" : undefined}
              title={v.label}
            >
              <Icon>{v.icon}</Icon>
              <span className="nav-label">{v.label}</span>
            </a>
          ))}
        </div>
        {settings && (
          <a className="agent-card" href="#settings/runtime" title={model ? `Pi · ${model}` : "Change the Pi model"}>
            <small>Pi</small>
            <span>Pi</span>
            <code>{model ?? "default model"}</code>
          </a>
        )}
      </nav>
      <main className={`content${view === "team" ? " content-fill" : " content-narrow"}`}>
        {!props && viewFallback}
        <Suspense fallback={viewFallback}>
        {props && view === "overview" && <Overview {...props} />}
        {props && view === "team" && (
          <TeamChat
            key={hash.startsWith("#team/") ? hash : "team"}
            transport={ownerTransport}
            initialThread={hashThread()}
            linkFor={shareLink ? (id) => api.share(id).then((r) => r.link) : undefined}
            notify={notify}
            shareSlot={<SharePanel link={shareLink} setLink={setShareLink} notify={notify} />}
            repos={Object.entries(settings.repos).map(([name, r]) => ({ name, ...(r.base && { base: r.base }) }))}
            personas={settings.personas}
          />
        )}
        {props && view === "create" && <CreateView {...props} />}
        {props && view === "schedules" && <Schedules {...props} />}
        {props && view === "insights" && <InsightsView {...props} />}
        {props && view === "settings" && <SettingsView {...props} />}
        </Suspense>
      </main>
      {toast && (
        <div className={`toast ${toast.error ? "error" : ""}`} role="status">
          {toast.text}
        </div>
      )}
    </div>
  );
}
