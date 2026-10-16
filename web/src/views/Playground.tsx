import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { Icon, type ViewProps } from "../App";

interface Message {
  bot: boolean;
  text: string;
  time: string;
  /** Context footer split off a bot reply ("— model · where · context …"). */
  footer?: string;
}

interface PlayThread {
  id: string;
  title: string;
  messages: Message[];
}

const STORAGE = "gchat-agents.playground";
const SUGGESTIONS = ["/help", "/repo ", "/up", "/status", "/context", "/compact", "/model ", "/schedules"];

function now(): string {
  return new Date().toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

function load(): PlayThread[] {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE) ?? "[]") as PlayThread[];
    if (saved.length) return saved;
  } catch {
    // private window or corrupt: start fresh
  }
  return [{ id: crypto.randomUUID().slice(0, 8), title: "Playground thread", messages: [] }];
}

/** Splits the bridge's context footer off a reply so it renders as metadata. */
function splitFooter(text: string): Pick<Message, "text" | "footer"> {
  const m = text.match(/\n\n— (.+)$/);
  return m ? { text: text.slice(0, m.index), footer: m[1] } : { text };
}

export function Playground({ settings }: ViewProps) {
  const [threads, setThreads] = useState<PlayThread[]>(load);
  const [activeId, setActiveId] = useState(threads[0]!.id);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [context, setContext] = useState<string>();
  const bottom = useRef<HTMLDivElement>(null);
  const active = threads.find((t) => t.id === activeId) ?? threads[0]!;

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE, JSON.stringify(threads));
    } catch {
      // storage unavailable: playground still works for this visit
    }
  }, [threads]);
  // Block body on purpose: scrollIntoView returns a Promise in recent Chrome, and an
  // effect must return nothing or a cleanup function ("destroy is not a function").
  useEffect(() => {
    bottom.current?.scrollIntoView({ block: "end" });
  }, [active.messages.length, busy]);

  const append = (id: string, msgs: Message[]) =>
    setThreads((all) =>
      all.map((t) =>
        t.id === id
          ? { ...t, messages: [...t.messages, ...msgs], title: t.messages.length === 0 && !msgs[0]?.bot ? msgs[0]!.text.slice(0, 40) : t.title }
          : t,
      ),
    );

  async function send(text = draft) {
    const value = text.trim();
    if (!value || busy) return;
    const id = active.id;
    setDraft("");
    append(id, [{ bot: false, text: value, time: now() }]);
    setBusy(true);
    try {
      const r = await api.playground(id, value);
      append(id, r.replies.map((reply) => ({ bot: true, time: now(), ...splitFooter(reply) })));
      setContext(r.context);
    } catch (err) {
      append(id, [{ bot: true, time: now(), text: `Request failed: ${err instanceof Error ? err.message : String(err)}` }]);
    } finally {
      setBusy(false);
    }
  }

  function newThread() {
    const t = { id: crypto.randomUUID().slice(0, 8), title: "New thread", messages: [] };
    setThreads((all) => [t, ...all]);
    setActiveId(t.id);
    setContext(undefined);
  }

  return (
    <div className="playground">
      <aside className="play-threads" aria-label="Test threads">
        <div className="play-threads-head">
          <h1>Playground</h1>
          <button className="btn icon" onClick={newThread} aria-label="New test thread">
            <Icon>
              <path d="M12 5v14M5 12h14" />
            </Icon>
          </button>
        </div>
        <p className="muted small">Talk to this bridge without Google Chat. Same agent, sessions and commands.</p>
        <div className="play-list">
          {threads.map((t) => (
            <button key={t.id} className={t.id === active.id ? "active" : ""} onClick={() => setActiveId(t.id)}>
              <span className="strong">{t.title}</span>
              <span className="muted small">{t.messages.length} messages</span>
            </button>
          ))}
        </div>
      </aside>

      <section className="play-chat" aria-label="Conversation">
        <header className="play-head">
          <span className="strong">{active.title}</span>
          {context && <code className="tag">{context}</code>}
          <span className="muted small push">Runs on this machine with {settings.agentDriver === "claude" ? "Claude Code" : "OpenCode"}</span>
        </header>

        <div className="messages">
          {active.messages.length === 0 && (
            <p className="empty">
              Say something, or start with <code>/help</code>. Use <code>/repo &lt;name&gt;</code> to give this thread a worktree.
            </p>
          )}
          {active.messages.map((m, i) => (
            <div key={i} className="message">
              <span className={`avatar ${m.bot ? "bot" : ""}`} aria-hidden="true">
                {m.bot ? (
                  <Icon>
                    <rect x="5" y="8" width="14" height="11" rx="3" />
                    <path d="M12 4v4" />
                  </Icon>
                ) : (
                  "You"
                )}
              </span>
              <div className="message-body">
                <div>
                  <span className="strong">{m.bot ? "gchat-agents" : "You"}</span> <span className="muted small">{m.time}</span>
                </div>
                <div className="message-text">{m.text}</div>
                {m.footer && <div className="message-footer">{m.footer}</div>}
              </div>
            </div>
          ))}
          {busy && <p className="muted small working">gchat-agents is working…</p>}
          <div ref={bottom} />
        </div>

        <div className="composer-wrap">
          <div className="suggestions">
            {SUGGESTIONS.map((s) => (
              <button key={s} className="chip" onClick={() => (s.endsWith(" ") ? setDraft(s) : void send(s))} disabled={busy}>
                {s.trim()}
              </button>
            ))}
          </div>
          <form
            className="composer"
            onSubmit={(e) => {
              e.preventDefault();
              void send();
            }}
          >
            <label htmlFor="composer" className="sr-only">
              Message the bot
            </label>
            <input id="composer" value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Message gchat-agents, or /help" autoComplete="off" />
            <button className="send" aria-label="Send" disabled={busy || !draft.trim()}>
              <Icon size={18}>
                <path d="M5 12h14M13 6l6 6-6 6" />
              </Icon>
            </button>
          </form>
        </div>
      </section>
    </div>
  );
}
