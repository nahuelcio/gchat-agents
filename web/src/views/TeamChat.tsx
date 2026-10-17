import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import {
  ago,
  api,
  type AgentQuestion,
  type MessageAttachment,
  type TeamAttachmentInput,
  type TeamThreadState,
  type TeamThreadSummary,
  type TeamTransport,
} from "../api";
import { Icon } from "../App";
import { canListen, canSpeak, speakText, startDictation, stopSpeaking, type LiveDictation } from "../speech";

const OWNER_SUGGESTIONS = ["/help", "/repo ", "/up", "/status", "/wi ", "/context", "/compact", "/model ", "/schedules"];
const GUEST_SUGGESTIONS = ["/help", "/context", "/compact", "/clear", "/model "];
const IMAGE_PART =
  /(!\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)|(https?:\/\/[^\s<>"]+\.(?:png|jpe?g|gif|webp|svg)(?:\?[^\s<>"]*)?))/gi;

/** Per-browser memory (names, a guest's own threads). Storage may be unavailable: then it just isn't remembered. */
function remember<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}
function store(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // private window: fine
  }
}

const newId = () => `t-${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;

/** Options under a bot question. One question sends on click; several wait until each has a pick. */
function AgentQuestions({
  questions,
  disabled,
  onAnswer,
}: {
  questions: AgentQuestion[];
  disabled: boolean;
  onAnswer: (text: string) => void;
}) {
  const [picked, setPicked] = useState<Record<number, string[]>>({});
  const single = questions.length === 1 && !questions[0]?.multiple;

  function choose(index: number, label: string, multiple?: boolean) {
    if (single) {
      onAnswer(label);
      return;
    }
    setPicked((prev) => {
      const cur = prev[index] ?? [];
      const next = multiple ? (cur.includes(label) ? cur.filter((x) => x !== label) : [...cur, label]) : [label];
      return { ...prev, [index]: next };
    });
  }

  const ready = questions.every((q, i) => (picked[i]?.length ?? 0) > 0);

  return (
    <div className="ask">
      {questions.map((q, i) => (
        <div key={q.question} className="ask-q">
          {!single && <div className="strong">{q.header}</div>}
          <div className="ask-options">
            {q.options.map((o) => {
              const on = picked[i]?.includes(o.label);
              return (
                <button
                  key={o.label}
                  type="button"
                  className={`chip ${on ? "on" : ""}`}
                  disabled={disabled}
                  title={o.description}
                  onClick={() => choose(i, o.label, q.multiple)}
                >
                  {o.label}
                </button>
              );
            })}
          </div>
        </div>
      ))}
      {!single && (
        <button type="button" className="btn small" disabled={disabled || !ready} onClick={() => onAnswer(questions.map((q, i) => (picked[i] ?? []).join(", ")).join("\n"))}>
          Send answers
        </button>
      )}
    </div>
  );
}

/** Splits the bridge's context footer off a reply so it renders as metadata. */
function splitFooter(text: string): { text: string; footer?: string } {
  const m = text.match(/\n\n— (.+)$/);
  return m ? { text: text.slice(0, m.index), footer: m[1] } : { text };
}

function isImageType(contentType: string): boolean {
  return contentType.startsWith("image/");
}

/** Renders plain text plus markdown / bare image URLs as actual images. */
function MessageContent({ text, attachments, mediaUrl }: { text: string; attachments?: MessageAttachment[]; mediaUrl: (id: string) => string }) {
  const parts: ReactNode[] = [];
  let last = 0;
  const re = new RegExp(IMAGE_PART.source, "gi");
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > last) parts.push(text.slice(last, m.index));
    const url = m[3] || m[4] || m[1];
    const alt = m[2] || "image";
    parts.push(<img key={`img-${m.index}`} className="message-image" src={url} alt={alt} loading="lazy" />);
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  const images = (attachments ?? []).filter((a) => isImageType(a.contentType));
  const files = (attachments ?? []).filter((a) => !isImageType(a.contentType));
  const hidePlaceholder = Boolean(images.length) && text.trim() === "(image)";
  return (
    <>
      {images.length > 0 && (
        <div className="message-images">
          {images.map((a) => (
            <a key={a.id} href={mediaUrl(a.id)} target="_blank" rel="noreferrer">
              <img className="message-image" src={mediaUrl(a.id)} alt={a.name ?? "attachment"} loading="lazy" />
            </a>
          ))}
        </div>
      )}
      {!hidePlaceholder && parts.length > 0 && <div className="message-text">{parts}</div>}
      {files.map((a) => (
        <a key={a.id} className="message-file" href={mediaUrl(a.id)} target="_blank" rel="noreferrer">
          {a.name ?? a.contentType}
        </a>
      ))}
    </>
  );
}

async function fileToAttachment(file: File): Promise<TeamAttachmentInput> {
  const buf = await file.arrayBuffer();
  const bytes = new Uint8Array(buf);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!);
  return { contentType: file.type || "application/octet-stream", data: btoa(binary), name: file.name };
}

interface Props {
  transport: TeamTransport;
  /** Thread to open first (deeplink). */
  initialThread?: string;
  /** Builds the public deeplink for a thread, when sharing is available. */
  linkFor?: (thread: string) => string | undefined;
  notify: (text: string, error?: boolean) => void;
  /** Owner only: the share panel. */
  shareSlot?: React.ReactNode;
  /** Owner only: repos a new thread can start in. */
  repos?: { name: string; base?: string }[];
}

export function TeamChat({ transport, initialThread, linkFor, notify, shareSlot, repos }: Props) {
  const [picking, setPicking] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const [name, setName] = useState<string>(() => remember("gchat-agents.name", ""));
  const [nameDraft, setNameDraft] = useState("");
  const [threads, setThreads] = useState<TeamThreadSummary[]>(() => (transport.guest ? remember("gchat-agents.guest-threads", []) : []));
  const [activeId, setActiveId] = useState<string | undefined>(initialThread);
  const [state, setState] = useState<TeamThreadState>();
  const [draft, setDraft] = useState("");
  const [pending, setPending] = useState<{ file: File; url: string }[]>([]);
  const [sending, setSending] = useState(false);
  const [listening, setListening] = useState(false);
  const [speakingId, setSpeakingId] = useState<number | null>(null);
  const [agents, setAgents] = useState<{ id: string; name: string }[]>([]);
  const [speechIn] = useState(canListen);
  const [speechOut] = useState(canSpeak);
  const bottom = useRef<HTMLDivElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const dictation = useRef<LiveDictation | undefined>(undefined);
  const draftBase = useRef("");
  const pendingRef = useRef(pending);
  pendingRef.current = pending;
  useEffect(
    () => () => {
      for (const p of pendingRef.current) URL.revokeObjectURL(p.url);
      dictation.current?.stop();
      stopSpeaking();
    },
    [],
  );

  function toggleListen() {
    if (!speechIn || sending) return;
    if (listening) {
      dictation.current?.stop();
      return;
    }
    draftBase.current = draft.trim();
    const session = startDictation({
      onPartial: (text) => {
        const base = draftBase.current;
        setDraft(base ? `${base} ${text}` : text);
      },
      onFinal: (text) => {
        const base = draftBase.current;
        const next = base ? `${base} ${text}` : text;
        draftBase.current = next;
        setDraft(next);
      },
      onError: (message) => notify(message, true),
      onEnd: () => {
        setListening(false);
        dictation.current = undefined;
      },
    });
    if (!session) {
      notify("Speech recognition is not supported in this browser", true);
      return;
    }
    dictation.current = session;
    setListening(true);
    session.start();
  }

  function toggleSpeak(id: number, text: string) {
    if (!speechOut) return;
    if (speakingId === id) {
      stopSpeaking();
      setSpeakingId(null);
      return;
    }
    stopSpeaking();
    setSpeakingId(id);
    speakText(text, () => setSpeakingId((cur) => (cur === id ? null : cur)));
  }

  function queueImages(files: FileList | File[]) {
    const images = [...files].filter((f) => f.type.startsWith("image/"));
    if (!images.length) return;
    setPending((prev) => {
      const room = Math.max(0, 5 - prev.length);
      return [...prev, ...images.slice(0, room).map((file) => ({ file, url: URL.createObjectURL(file) }))];
    });
  }

  function clearPending() {
    setPending((prev) => {
      for (const p of prev) URL.revokeObjectURL(p.url);
      return [];
    });
  }

  // Guests keep their own thread list; a deeplinked thread joins it.
  useEffect(() => {
    if (!transport.guest || !initialThread) return;
    setThreads((list) => (list.some((t) => t.id === initialThread) ? list : [{ id: initialThread, title: "Shared thread", count: 0 }, ...list]));
  }, [transport.guest, initialThread]);
  useEffect(() => {
    if (transport.guest) store("gchat-agents.guest-threads", threads);
  }, [transport.guest, threads]);

  const loadThreads = useCallback(() => {
    transport.threads?.(showArchived).then(setThreads, () => {});
  }, [transport, showArchived]);

  useEffect(() => {
    loadThreads();
    transport.agents().then(setAgents, () => {});
  }, [transport, loadThreads]);

  useEffect(() => {
    if (!activeId && threads[0]) setActiveId(threads[0].id);
  }, [activeId, threads]);

  // Live: poll the open thread so teammates' messages and "working…" show up.
  useEffect(() => {
    if (!activeId) return;
    let alive = true;
    const load = () =>
      transport.thread(activeId).then(
        (s) => {
          if (!alive) return;
          setState(s);
          if (transport.guest) {
            const title = s.messages.find((m) => !m.bot)?.text.slice(0, 60);
            if (title) setThreads((list) => list.map((t) => (t.id === activeId ? { ...t, title, count: s.messages.length } : t)));
          }
        },
        () => {},
      );
    void load();
    const id = setInterval(load, 3000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [activeId, transport]);

  // Block body: scrollIntoView returns a Promise in recent Chrome; an effect must not return it.
  useEffect(() => {
    bottom.current?.scrollIntoView({ block: "end" });
  }, [state?.messages.length, sending]);

  async function send(text = draft, threadId = activeId, files = pending.map((p) => p.file)) {
    const value = text.trim();
    if ((!value && !files.length) || sending || !threadId) return;
    setDraft("");
    clearPending();
    setSending(true);
    setState((s) =>
      s
        ? {
            ...s,
            messages: [...s.messages, { author: name, text: value || "(image)", bot: false }],
            busy: true,
          }
        : s,
    );
    try {
      const attachments = files.length ? await Promise.all(files.map(fileToAttachment)) : undefined;
      await transport.send(threadId, value, name, attachments);
      setState(await transport.thread(threadId));
      loadThreads();
    } catch (err) {
      notify(err instanceof Error ? err.message : String(err), true);
    } finally {
      setSending(false);
    }
  }

  /** Owners pick where the thread works first; guests (no repos) start chat-only. */
  function newThread(repo?: string) {
    const id = newId();
    setPicking(false);
    setThreads((list) => [{ id, title: repo ? `Work in ${repo}` : "New thread", count: 0 }, ...list]);
    setActiveId(id);
    setState({ messages: [], agent: null, busy: false });
    if (repo) void send(`/repo ${repo}`, id);
  }

  async function archive() {
    if (!activeId || !transport.archive) return;
    await transport.archive(activeId, !showArchived).then(
      () => notify(showArchived ? "Thread restored" : "Thread archived — find it under Archived"),
      (e: Error) => notify(e.message, true),
    );
    setActiveId(undefined);
    setState(undefined);
    loadThreads();
  }

  async function remove() {
    if (!activeId) return;
    if (!transport.remove) {
      // Guests only forget it locally; the thread stays for everyone else.
      setThreads((list) => list.filter((t) => t.id !== activeId));
      setActiveId(undefined);
      setState(undefined);
      return;
    }
    const hasRepo = Boolean(state?.repo);
    const ok = confirm(
      `Delete this thread for everyone? Its history and agent session are removed${hasRepo ? `, and its worktree too (branch ${state?.branch} stays in the repo)` : ""}. This cannot be undone.`,
    );
    if (!ok) return;
    await transport.remove(activeId).then(
      (r) => notify(r.branchKept ? `Thread deleted; branch ${r.branchKept} kept` : "Thread deleted"),
      (e: Error) => notify(e.message, true),
    );
    setActiveId(undefined);
    setState(undefined);
    loadThreads();
  }

  function copyLink() {
    const link = activeId && linkFor?.(activeId);
    if (!link) return notify("Sharing needs the tunnel (start with TUNNEL on).", true);
    navigator.clipboard.writeText(link).then(() => notify("Link to this thread copied"), () => notify("Copy failed", true));
  }

  if (!name) {
    return (
      <div className="name-gate">
        <form
          className="card"
          onSubmit={(e) => {
            e.preventDefault();
            const value = nameDraft.trim().slice(0, 40);
            if (!value) return;
            store("gchat-agents.name", value);
            setName(value);
          }}
        >
          <h1>Team chat</h1>
          <p className="muted">The agent and your teammates see this name on your messages.</p>
          <label className="field">
            <span>Your name</span>
            <input autoFocus value={nameDraft} onChange={(e) => setNameDraft(e.target.value)} placeholder="Ana" />
          </label>
          <button className="btn primary">Continue</button>
        </form>
      </div>
    );
  }

  const active = threads.find((t) => t.id === activeId);
  const suggestions = transport.guest ? GUEST_SUGGESTIONS : OWNER_SUGGESTIONS;
  const working = sending || state?.busy;

  return (
    <div className={`playground ${transport.guest ? "standalone" : ""}`}>
      <aside className="play-threads" aria-label="Threads">
        <div className="play-threads-head">
          <h1>Team chat</h1>
          <button className="btn icon" onClick={() => (repos?.length ? setPicking(!picking) : newThread())} aria-label="New thread" aria-expanded={picking}>
            <Icon>
              <path d="M12 5v14M5 12h14" />
            </Icon>
          </button>
        </div>
        <p className="muted small">
          {transport.guest ? `Chatting as ${name}. ` : "Every team thread. "}
          <button className="linklike" onClick={() => { store("gchat-agents.name", ""); setName(""); }}>
            Change name
          </button>
        </p>
        {picking && (
          <div className="repo-pick" role="group" aria-label="Where should the new thread work?">
            <span className="small strong">Where should it work?</span>
            <button onClick={() => newThread()}>
              <span className="strong">Chat only</span>
              <span className="muted small">No repo, an empty workspace</span>
            </button>
            {repos?.map((r) => (
              <button key={r.name} onClick={() => newThread(r.name)}>
                <span className="strong">{r.name}</span>
                <span className="muted small">New worktree from {r.base ?? "HEAD"}</span>
              </button>
            ))}
          </div>
        )}
        {shareSlot}
        {transport.threads && (
          <div className="tabs" role="tablist" aria-label="Thread list">
            <button role="tab" aria-selected={!showArchived} className={showArchived ? "" : "on"} onClick={() => { setShowArchived(false); setActiveId(undefined); }}>
              Active
            </button>
            <button role="tab" aria-selected={showArchived} className={showArchived ? "on" : ""} onClick={() => { setShowArchived(true); setActiveId(undefined); }}>
              Archived
            </button>
          </div>
        )}
        <div className="play-list">
          {threads.length === 0 && <p className="muted small pad">{showArchived ? "No archived threads." : "No threads yet. Start one with +."}</p>}
          {threads.map((t) => (
            <button key={t.id} className={t.id === activeId ? "active" : ""} onClick={() => setActiveId(t.id)}>
              <span className="strong">{t.title}</span>
              <span className="muted small">
                {t.count} messages{t.updatedAt ? ` · ${ago(t.updatedAt)}` : ""}
              </span>
            </button>
          ))}
        </div>
      </aside>

      <section className="play-chat" aria-label="Conversation">
        <header className="play-head">
          <span className="strong title">{active?.title ?? "Team chat"}</span>
          {state?.repo && <code className="tag">{state.repo} · {state.branch}</code>}
          {activeId && agents.length > 1 && (
            <label className="agent-pick">
              <span className="sr-only">Agent for this thread</span>
              <select
                value={state?.agent ?? ""}
                onChange={(e) => void send(`/agent ${e.target.value || "default"}`)}
                disabled={working}
              >
                <option value="">Default agent</option>
                {agents.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          <span className="head-actions push">
            {activeId && linkFor && (
              <button className="btn small" onClick={copyLink}>
                Copy link
              </button>
            )}
            {activeId && transport.archive && (
              <button className="btn small" onClick={() => void archive()} disabled={working}>
                {showArchived ? "Restore" : "Archive"}
              </button>
            )}
            {activeId && (
              <button className="btn small danger" onClick={() => void remove()} disabled={working}>
                {transport.remove ? "Delete" : "Hide"}
              </button>
            )}
          </span>
        </header>

        <div className="play-main">
        <div className="play-stream">
        <div className="messages">
          {!activeId && <p className="empty">Start a thread with +.</p>}
          {activeId && state?.messages.length === 0 && (
            <p className="empty">
              Say something, or start with <code>/help</code>.{!transport.guest && <> Use <code>/repo &lt;name&gt;</code> to give this thread a worktree.</>}
            </p>
          )}
          {state?.messages.map((m, i, all) => {
            const body = m.bot ? splitFooter(m.text) : { text: m.text };
            const mine = !m.bot && m.author === name;
            return (
              <div key={i} className="message">
                <span className={`avatar ${m.bot ? "bot" : ""}`} aria-hidden="true">
                  {m.bot ? (
                    <Icon>
                      <rect x="5" y="8" width="14" height="11" rx="3" />
                      <path d="M12 4v4" />
                    </Icon>
                  ) : (
                    m.author.slice(0, 2).toUpperCase()
                  )}
                </span>
                <div className="message-body">
                  <div>
                    <span className="strong">{mine ? `${m.author} (you)` : m.author}</span>{" "}
                    {m.at && <span className="muted small">{new Date(m.at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}</span>}
                  </div>
                  <MessageContent text={body.text} attachments={m.attachments} mediaUrl={transport.mediaUrl} />
                  {body.footer && <div className="message-footer">{body.footer}</div>}
                  {m.bot && speechOut && body.text.trim() && (
                    <button
                      type="button"
                      className={`speak-btn ${speakingId === i ? "on" : ""}`}
                      aria-label={speakingId === i ? "Stop speaking" : "Speak message"}
                      onClick={() => toggleSpeak(i, body.text)}
                    >
                      <Icon size={14}>
                        {speakingId === i ? (
                          <rect x="7" y="7" width="10" height="10" />
                        ) : (
                          <>
                            <polygon points="5,4 15,12 5,20" />
                            <path d="M17 8a5 5 0 0 1 0 8" />
                          </>
                        )}
                      </Icon>
                      {speakingId === i ? "Stop" : "Listen"}
                    </button>
                  )}
                  {m.questions && m.questions.length > 0 && !all.slice(i + 1).some((later) => !later.bot) && (
                    <AgentQuestions questions={m.questions} disabled={sending} onAnswer={(text) => void send(text)} />
                  )}
                </div>
              </div>
            );
          })}
          {working && <p className="muted small working">Switchboard is working…</p>}
          <div ref={bottom} />
        </div>

        {activeId && (
          <div className="composer-wrap">
            <div className="suggestions">
              {suggestions.map((s) => (
                <button key={s} className="chip" onClick={() => (s.endsWith(" ") ? setDraft(s) : void send(s))} disabled={sending}>
                  {s.trim()}
                </button>
              ))}
            </div>
            {pending.length > 0 && (
              <div className="composer-previews">
                {pending.map((p, i) => (
                  <div key={p.url} className="composer-preview">
                    <img src={p.url} alt={p.file.name} />
                    <button
                      type="button"
                      className="x"
                      aria-label={`Remove ${p.file.name}`}
                      onClick={() =>
                        setPending((prev) => {
                          const next = [...prev];
                          const [removed] = next.splice(i, 1);
                          if (removed) URL.revokeObjectURL(removed.url);
                          return next;
                        })
                      }
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>
            )}
            <form
              className="composer"
              onSubmit={(e) => {
                e.preventDefault();
                void send();
              }}
              onPaste={(e) => {
                const files = [...e.clipboardData.files].filter((f) => f.type.startsWith("image/"));
                if (files.length) {
                  e.preventDefault();
                  queueImages(files);
                }
              }}
            >
              <label htmlFor="composer" className="sr-only">
                Message the agent
              </label>
              <input
                ref={fileInput}
                type="file"
                accept="image/*"
                multiple
                hidden
                onChange={(e) => {
                  if (e.target.files) queueImages(e.target.files);
                  e.target.value = "";
                }}
              />
              <button type="button" className="attach" aria-label="Attach image" disabled={sending} onClick={() => fileInput.current?.click()}>
                <Icon size={18}>
                  <rect x="4" y="5" width="16" height="14" rx="2" />
                  <circle cx="9" cy="10" r="1.5" />
                  <path d="M4 16l4-4 3 3 3-4 6 5" />
                </Icon>
              </button>
              {speechIn && (
                <button
                  type="button"
                  className={`attach mic ${listening ? "on" : ""}`}
                  aria-label={listening ? "Stop listening" : "Speak to text"}
                  disabled={sending}
                  onClick={toggleListen}
                >
                  <Icon size={18}>
                    <path d="M12 3a3 3 0 0 1 3 3v6a3 3 0 0 1-6 0V6a3 3 0 0 1 3-3z" />
                    <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
                  </Icon>
                </button>
              )}
              <input
                id="composer"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                placeholder={listening ? "Listening…" : "Message, paste an image, or use the mic"}
                autoComplete="off"
              />
              <button className="send" aria-label="Send" disabled={sending || (!draft.trim() && !pending.length)}>
                <Icon size={18}>
                  <path d="M5 12h14M13 6l6 6-6 6" />
                </Icon>
              </button>
            </form>
          </div>
        )}
        </div>

        {activeId && <ThreadContextPanel state={state} guest={transport.guest} />}
        </div>
      </section>
    </div>
  );
}

function changeSummary(changes: NonNullable<TeamThreadState["changes"]>): string {
  if (changes.clean) return "Clean working tree";
  const parts: string[] = [];
  if (changes.staged) parts.push(`${changes.staged} staged`);
  if (changes.unstaged) parts.push(`${changes.unstaged} modified`);
  if (changes.untracked) parts.push(`${changes.untracked} untracked`);
  return parts.join(" · ") || `${changes.files.length} changes`;
}

function ThreadContextPanel({ state, guest }: { state?: TeamThreadState; guest: boolean }) {
  const wi = state?.workItem;
  const changes = state?.changes;
  return (
    <aside className="play-context" aria-label="Thread context">
      <h2>Context</h2>
      <dl>
        <div>
          <dt>Repo</dt>
          <dd>{state?.repo ? <code>{state.repo}</code> : <span className="muted">Chat only</span>}</dd>
        </div>
        {state?.branch && (
          <div>
            <dt>Branch</dt>
            <dd>
              <code>{state.branch}</code>
            </dd>
          </div>
        )}
        {state?.worktree && (
          <div>
            <dt>Worktree</dt>
            <dd>
              <code className="path">{state.worktree}</code>
            </dd>
          </div>
        )}
        <div>
          <dt>Agent</dt>
          <dd>{state?.agent ?? "default"}{state?.model ? ` · ${state.model}` : ""}</dd>
        </div>
        {state?.context && (
          <div>
            <dt>Session</dt>
            <dd className="mono muted small">{state.context}</dd>
          </div>
        )}
        {state?.repo && (
          <div>
            <dt>App</dt>
            <dd>
              {state.app?.running && state.app.port ? (
                <a className="pill ok" href={`http://localhost:${state.app.port}`} target="_blank" rel="noreferrer">
                  <span className="dot" aria-hidden="true" />
                  :{state.app.port}
                </a>
              ) : (
                <span className="pill">Stopped</span>
              )}
            </dd>
          </div>
        )}
      </dl>

      <h2>Work item</h2>
      {wi ? (
        <div className="play-wi">
          <div className="strong">
            {wi.url ? (
              <a href={wi.url} target="_blank" rel="noreferrer">
                #{wi.id}
              </a>
            ) : (
              <>#{wi.id}</>
            )}
            {wi.type ? ` · ${wi.type}` : ""}
          </div>
          {wi.title && <p>{wi.title}</p>}
          {wi.state && <span className="pill">{wi.state}</span>}
        </div>
      ) : (
        <p className="muted small">
          {guest ? "No work item on this thread." : (
            <>
              None. Set one with <code>/wi &lt;id&gt;</code>.
            </>
          )}
        </p>
      )}

      <h2>Changes</h2>
      {!state?.worktree ? (
        <p className="muted small">No worktree yet.</p>
      ) : !changes ? (
        <p className="muted small">Could not read git status.</p>
      ) : (
        <>
          <p className={`small ${changes.clean ? "muted" : "strong"}`}>{changeSummary(changes)}</p>
          {changes.files.length > 0 && (
            <ul className="play-changes">
              {changes.files.map((f) => (
                <li key={`${f.status}:${f.path}`}>
                  <code className="status">{f.status}</code>
                  <code className="path">{f.path}</code>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </aside>
  );
}

/** Owner's share panel: the team link, copy, open, rotate. */
export function SharePanel({ link, setLink, notify }: { link?: string; setLink: (l: string) => void; notify: (t: string, e?: boolean) => void }) {
  if (!link) return <p className="muted small pad">Sharing needs the tunnel (start with TUNNEL on).</p>;
  return (
    <div className="share-panel">
      <span className="small strong">Share team chat</span>
      <div className="share-actions">
        <button className="btn small" onClick={() => navigator.clipboard.writeText(link).then(() => notify("Team chat link copied"), () => notify("Copy failed", true))}>
          Copy link
        </button>
        <a className="btn small" href={link} target="_blank" rel="noreferrer">
          Open
        </a>
        <button
          className="btn small ghost"
          onClick={() => {
            if (!confirm("Create a new link? Everyone with the current link loses access.")) return;
            api.rotateShare().then((r) => {
              setLink(r.link);
              notify("New link created; the old one no longer works");
            }, (e: Error) => notify(e.message, true));
          }}
        >
          New link
        </button>
      </div>
      <span className="muted small">Guests can chat and use /context /compact /clear /model /agent. Worktree, app and schedule commands stay yours.</span>
    </div>
  );
}
