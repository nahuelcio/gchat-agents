import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { AgentBlob } from "../AgentBlob";
import { agentTint, BOT_NAME } from "../agent-color";
import {
  ago,
  api,
  type AgentQuestion,
  type MessageAttachment,
  type MemberChange,
  type Persona,
  type PersonaAvatar,
  type TeamAttachmentInput,
  type TeamThreadState,
  type TeamThreadSummary,
  type TeamTransport,
} from "../api";
import { Icon } from "../App";
import { MermaidDiagram } from "../MermaidDiagram";
import { canListen, canSpeak, speakText, startDictation, stopSpeaking, type LiveDictation } from "../speech";

const IMAGE_PART =
  /(!\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)|(https?:\/\/[^\s<>"]+\.(?:png|jpe?g|gif|webp|svg)(?:\?[^\s<>"]*)?))/gi;

const MERMAID_FENCE = /```mermaid[ \t]*\r?\n([\s\S]*?)```/gi;

/** @handle being typed at the caret, if any. */
function activeMention(text: string, caret: number): { start: number; query: string } | null {
  const before = text.slice(0, caret);
  const m = /(?:^|[^\w@])@([A-Za-z0-9_-]*)$/.exec(before);
  if (!m) return null;
  const query = m[1] ?? "";
  return { start: before.length - query.length - 1, query };
}

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

function textWithImages(text: string, keyPrefix: string): ReactNode[] {
  const parts: ReactNode[] = [];
  let last = 0;
  const re = new RegExp(IMAGE_PART.source, "gi");
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > last) parts.push(text.slice(last, m.index));
    const url = m[3] || m[4] || m[1];
    const alt = m[2] || "image";
    parts.push(<img key={`${keyPrefix}-img-${m.index}`} className="message-image" src={url} alt={alt} loading="lazy" />);
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}

function MessageContent({ text, attachments, mediaUrl }: { text: string; attachments?: MessageAttachment[]; mediaUrl: (id: string) => string }) {
  const parts: ReactNode[] = [];
  let last = 0;
  const re = new RegExp(MERMAID_FENCE.source, "gi");
  let m: RegExpExecArray | null;
  let chunk = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) {
      const chunkParts = textWithImages(text.slice(last, m.index), `t${chunk}`);
      if (chunkParts.length) parts.push(<div key={`t-${chunk}`} className="message-text">{chunkParts}</div>);
      chunk++;
    }
    parts.push(<MermaidDiagram key={`m-${m.index}`} source={m[1]!.replace(/\s+$/, "")} />);
    last = m.index + m[0].length;
  }
  if (last < text.length) {
    const chunkParts = textWithImages(text.slice(last), `t${chunk}`);
    if (chunkParts.length) parts.push(<div key={`t-${chunk}`} className="message-text">{chunkParts}</div>);
  }
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
      {!hidePlaceholder && parts}
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
  /** Owner: live list from settings. Guests load via transport. */
  personas?: Persona[];
}

/** Name + optional blob face — enough for @mentions and avatars. */
type PersonaRef = { name: string; avatar?: PersonaAvatar; prompt?: string };

export function TeamChat({ transport, initialThread, linkFor, notify, shareSlot, repos, personas: personasProp }: Props) {
  const [picking, setPicking] = useState(false);
  const [picked, setPicked] = useState<string[]>([]);
  const [showArchived, setShowArchived] = useState(false);
  const [name, setName] = useState<string>(() => remember("switchboard.name", ""));
  const [nameDraft, setNameDraft] = useState("");
  const [threads, setThreads] = useState<TeamThreadSummary[]>(() => (transport.guest ? remember("switchboard.guest-threads", []) : []));
  const [activeId, setActiveId] = useState<string | undefined>(initialThread);
  const [state, setState] = useState<TeamThreadState>();
  const [loadError, setLoadError] = useState<string>();
  const [draft, setDraft] = useState("");
  const [caret, setCaret] = useState(0);
  const [mentionHi, setMentionHi] = useState(0);
  const [mentionDismissed, setMentionDismissed] = useState(false);
  const [pending, setPending] = useState<{ file: File; url: string }[]>([]);
  const [sending, setSending] = useState(false);
  const [listening, setListening] = useState(false);
  const [speakingId, setSpeakingId] = useState<number | null>(null);
  const [agents, setAgents] = useState<{ id: string; name: string }[]>([]);
  const [guestPersonas, setGuestPersonas] = useState<PersonaRef[]>([]);
  const [speechIn] = useState(canListen);
  const [speechOut] = useState(canSpeak);
  const bottom = useRef<HTMLDivElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const composerInput = useRef<HTMLInputElement>(null);
  const dictation = useRef<LiveDictation | undefined>(undefined);
  const draftBase = useRef("");
  const pendingRef = useRef(pending);
  pendingRef.current = pending;
  const catalog = personasProp ?? guestPersonas;
  // In a room with a member list, only its agents can be @mentioned.
  const personas = useMemo(() => {
    const members = state?.members;
    if (!members) return catalog;
    const inRoom = new Set(members.flatMap((m) => (m.kind === "agent" ? [m.persona.toLowerCase()] : [])));
    return catalog.filter((p) => inRoom.has(p.name.toLowerCase()));
  }, [catalog, state?.members]);
  const mention = useMemo(() => activeMention(draft, caret), [draft, caret]);
  const mentionMatches = useMemo(() => {
    if (!mention) return [];
    const q = mention.query.toLowerCase();
    return personas.filter((p) => p.name.toLowerCase().startsWith(q));
  }, [mention, personas]);
  const mentionOpen = Boolean(mention) && !mentionDismissed;
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
    if (transport.guest) store("switchboard.guest-threads", threads);
  }, [transport.guest, threads]);

  const loadThreads = useCallback(() => {
    transport.threads?.(showArchived).then(setThreads, () => {});
  }, [transport, showArchived]);

  useEffect(() => {
    loadThreads();
    transport.agents().then(setAgents, () => {});
    if (!personasProp) transport.personas?.().then(setGuestPersonas, () => setGuestPersonas([]));
  }, [transport, loadThreads, personasProp]);

  useEffect(() => {
    setMentionHi(0);
    setMentionDismissed(false);
  }, [mention?.start, mention?.query]);

  function syncCaret(el: HTMLInputElement | null = composerInput.current) {
    if (el) setCaret(el.selectionStart ?? el.value.length);
  }

  function insertMention(name: string) {
    if (!mention) return;
    const next = `${draft.slice(0, mention.start)}@${name} ${draft.slice(caret)}`;
    const pos = mention.start + name.length + 2;
    setDraft(next);
    setCaret(pos);
    setMentionHi(0);
    setMentionDismissed(true);
    requestAnimationFrame(() => {
      const el = composerInput.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(pos, pos);
    });
  }

  function onComposerKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (!mentionOpen) return;
    if (e.key === "Escape") {
      e.preventDefault();
      setMentionDismissed(true);
      return;
    }
    if (mentionMatches.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setMentionHi((i) => (i + 1) % mentionMatches.length);
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      setMentionHi((i) => (i - 1 + mentionMatches.length) % mentionMatches.length);
      return;
    }
    if (e.key === "Enter" || e.key === "Tab") {
      e.preventDefault();
      const pick = mentionMatches[mentionHi] ?? mentionMatches[0];
      if (pick) insertMention(pick.name);
    }
  }

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
          setLoadError(undefined);
          setState(s);
          if (transport.guest) {
            const title = s.messages.find((m) => !m.bot)?.text.slice(0, 60);
            if (title) setThreads((list) => list.map((t) => (t.id === activeId ? { ...t, title, count: s.messages.length } : t)));
          }
        },
        (err: Error) => alive && setLoadError(err.message),
      );
    void load();
    const id = setInterval(load, 3000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [activeId, transport]);

  useEffect(() => {
    const list = bottom.current?.parentElement;
    if (list) list.scrollTop = list.scrollHeight;
  }, [state?.messages.length, sending]);

  async function send(text = draft, threadId = activeId, files = pending.map((p) => p.file)) {
    const value = text.trim();
    // Allow another message while a turn is still running — the server queues per thread.
    if ((!value && !files.length) || !threadId) return;
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
  function newThread(chosen: string[] = []) {
    const id = newId();
    setPicking(false);
    setPicked([]);
    setThreads((list) => [{ id, title: chosen.length ? `Work in ${chosen.join(", ")}` : "New thread", count: 0 }, ...list]);
    setActiveId(id);
    setState({ messages: [], agent: null, busy: false });
    if (chosen.length) void send(`/repo ${chosen.join(" ")}`, id);
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
    if (!link) return notify("Sharing needs a public tunnel: pick one in Settings › Public tunnel and restart.", true);
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
            store("switchboard.name", value);
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
          <button className="linklike" onClick={() => { store("switchboard.name", ""); setName(""); }}>
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
              <label key={r.name} className={`repo-option ${picked.includes(r.name) ? "on" : ""}`}>
                <input
                  type="checkbox"
                  checked={picked.includes(r.name)}
                  onChange={() => setPicked((list) => (list.includes(r.name) ? list.filter((x) => x !== r.name) : [...list, r.name]))}
                />
                <span className="strong">{r.name}</span>
                <span className="muted small">New worktree from {r.base ?? "HEAD"}</span>
              </label>
            ))}
            <button className="btn primary" disabled={!picked.length} onClick={() => newThread(picked)}>
              {picked.length > 1 ? `Start in ${picked.length} repos` : "Start in this repo"}
            </button>
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
          <span className="strong title">{state?.title ?? active?.title ?? "Team chat"}</span>
          {state?.repo ? <code className="tag">{state.repo} · {state.branch}</code> : state?.title?.startsWith("switchboard/") && <code className="tag muted">branch kept</code>}
          {(state?.agent || state?.model) && <code className="tag">{[state.agent, state.model].filter(Boolean).join(" · ")}</code>}
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
          {loadError && <p className="empty error" role="alert">{loadError}</p>}
          {!activeId && <p className="empty">Start a thread with +.</p>}
          {activeId && state?.messages.length === 0 && (
            <p className="empty">
              Say something, or start with <code>/help</code>.{!transport.guest && <> Use <code>/repo &lt;name&gt;</code> to give this thread a worktree.</>}
            </p>
          )}
          {state?.messages.map((m, i, all) => {
            const tagged = m.bot ? m.text.match(/^\*(@[\w.-]+)\*\s*/) : null;
            const body = m.bot ? splitFooter(tagged ? m.text.slice(tagged[0].length) : m.text) : { text: m.text };
            const mine = !m.bot && m.author === name;
            const agent = tagged?.[1] ?? (m.bot && m.author.startsWith("@") ? m.author : undefined);
            return (
              <div key={i} className={`message ${agent ? "agent-tint" : ""}`} style={agent ? agentTint(agent) : undefined}>
                <Face
                  host={m.bot && !agent}
                  agent={Boolean(agent)}
                  name={agent ?? m.author}
                  avatar={agent ? avatarOf(catalog, agent) : undefined}
                />
                <div className="message-body">
                  <div>
                    <span className="strong author" data-testid="message-author">{m.bot ? (agent ?? BOT_NAME) : mine ? `${m.author} (you)` : m.author}</span>{" "}
                    {m.at && <span className="muted small">{new Date(m.at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}</span>}
                  </div>
                  <MessageContent text={body.text} attachments={m.attachments} mediaUrl={transport.mediaUrl} />
                  {body.footer && <div className="message-footer">{body.footer}</div>}
                  {m.bot && speechOut && body.text.trim() && (
                    <button
                      type="button"
                      className={`speak-btn ${speakingId === i ? "on" : ""}`}
                      aria-label={speakingId === i ? "Stop speaking" : "Speak message"}
                      title={speakingId === i ? "Stop" : "Listen"}
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
                    </button>
                  )}
                  {m.questions && m.questions.length > 0 && !all.slice(i + 1).some((later) => !later.bot) && (
                    <AgentQuestions questions={m.questions} disabled={sending} onAnswer={(text) => void send(text)} />
                  )}
                </div>
              </div>
            );
          })}
          {working && (
            <div className="working" role="status" aria-live="polite">
              {(state?.answering?.length ? state.answering : [BOT_NAME]).map((n) => {
                const handle = n.replace(/^@/, "");
                const host = handle.toLowerCase() === BOT_NAME.toLowerCase();
                return (
                  <span key={handle} className="working-agent">
                    <AgentBlob
                      name={host ? BOT_NAME : handle}
                      avatar={host ? undefined : avatarOf(catalog, handle)}
                      size={28}
                      busy
                    />
                    <span className="muted small">{host ? BOT_NAME : `@${handle}`}</span>
                  </span>
                );
              })}
              {activeId && (
                <button
                  className="btn linkish"
                  onClick={() => void transport.stopAgents(activeId).catch(() => {})}
                  title="Agents stop handing off to each other after the current reply"
                >
                  Stop
                </button>
              )}
            </div>
          )}
          <div ref={bottom} />
        </div>

        {activeId && (
          <div className="composer-wrap">
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
            {mentionOpen && (
              <div className="suggestions" role="listbox" aria-label="Mention an agent">
                {mentionMatches.length > 0 ? (
                  mentionMatches.map((p, i) => (
                    <button
                      key={p.name}
                      type="button"
                      role="option"
                      aria-selected={i === mentionHi}
                      className={`chip ${i === mentionHi ? "on" : ""}`}
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => insertMention(p.name)}
                    >
                      @{p.name}
                    </button>
                  ))
                ) : personas.length === 0 ? (
                  <span className="muted small">No agents yet — add them under Create</span>
                ) : (
                  <span className="muted small">No agent matches @{mention?.query}</span>
                )}
              </div>
            )}
            <form
              className="composer"
              onSubmit={(e) => {
                e.preventDefault();
                if (mentionOpen && mentionMatches.length) return;
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
                ref={composerInput}
                id="composer"
                value={draft}
                onChange={(e) => {
                  setDraft(e.target.value);
                  setCaret(e.target.selectionStart ?? e.target.value.length);
                }}
                onClick={(e) => syncCaret(e.currentTarget)}
                onKeyUp={(e) => syncCaret(e.currentTarget)}
                onSelect={(e) => syncCaret(e.currentTarget)}
                onKeyDown={onComposerKeyDown}
                placeholder={listening ? "Listening…" : "Message @agent, paste an image, or use the mic"}
                autoComplete="off"
                aria-autocomplete="list"
                aria-expanded={mentionOpen}
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

        {activeId && (
          <ThreadContextPanel
            state={state}
            guest={transport.guest}
            catalog={catalog}
            onCommand={(text) => void send(text)}
            onMember={
              transport.members
                ? (op, member) =>
                    transport.members!(activeId, op, member).then(
                      async () => setState(await transport.thread(activeId)),
                      (err: unknown) => notify(err instanceof Error ? err.message : String(err), true),
                    )
                : undefined
            }
          />
        )}
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

function MembersSection({
  state,
  catalog,
  onMember,
}: {
  state?: TeamThreadState;
  catalog: PersonaRef[];
  onMember?: (op: "add" | "remove", member: MemberChange) => Promise<unknown>;
}) {
  const members = state?.members;
  const [adding, setAdding] = useState(false);
  const presenceOf = (id: string) => state?.presence?.find((p) => p.id === id);
  const host = presenceOf("host");
  const agentNames = new Set((members ?? []).flatMap((m) => (m.kind === "agent" ? [m.persona.toLowerCase()] : [])));
  const addable = members ? catalog.filter((p) => !agentNames.has(p.name.toLowerCase())) : [];
  return (
    <section className="room-members" aria-label="Members">
      <h2>Members</h2>
      {host && host.status !== "idle" && <p className={`presence ${host.status}`}>{host.name} · {host.status}</p>}
      {!members ? (
        <p className="muted small">
          {state?.messages.length ? "Older room: every agent from Settings can be @mentioned here." : "New room: no agents yet."}
          {onMember ? (state?.messages.length ? " Add one below to start a member list." : " Add the ones you want below.") : ""}
        </p>
      ) : (
        <ul className="member-list">
          {members.map((m) => (
            <li key={m.id} className={`member ${m.kind === "agent" ? "agent-tint" : ""}`} style={m.kind === "agent" ? agentTint(m.persona) : undefined}>
              {m.kind === "agent" ? (
                <Face name={m.persona} agent avatar={avatarOf(catalog, m.persona)} busy={presenceOf(m.id)?.status === "speaking"} />
              ) : (
                <span className="member-avatar" aria-hidden="true">{m.name.slice(0, 2).toUpperCase()}</span>
              )}
              <span className="grow">
                <span>{m.kind === "agent" ? `@${m.persona}` : m.name}</span>
                {m.kind === "agent" && presenceOf(m.id) && (
                  <span className={`presence ${presenceOf(m.id)!.status}`}>
                    {presenceOf(m.id)!.status}
                    {presenceOf(m.id)!.lastSeenN ? ` · saw #${presenceOf(m.id)!.lastSeenN}` : ""}
                  </span>
                )}
              </span>
              <span className={`badge ${m.kind === "agent" ? "agent" : ""}`}>{m.kind === "agent" ? "Agent" : "Person"}</span>
              {onMember && m.kind === "agent" && (
                <button className="x" aria-label={`Remove @${m.persona}`} onClick={() => void onMember("remove", { kind: "agent", persona: m.persona })}>
                  ×
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {!!state?.kicked?.length && (
        <p className="muted small">
          Removed: {state.kicked.map((n) => `@${n}`).join(", ")}. They can only come back if someone adds them again.
        </p>
      )}
      {members && !members.some((m) => m.kind === "agent") && <p className="empty small">No agents in this room yet.{onMember ? " Add one to bring it in." : ""}</p>}
      {onMember &&
        (catalog.length === 0 ? (
          <p className="muted small">Create agents under Create in the sidebar.</p>
        ) : adding || !members ? (
          <div className="model-chips">
            {(members ? addable : catalog).map((p) => (
              <button key={p.name} type="button" className="chip" onClick={() => void onMember("add", { kind: "agent", persona: p.name }).then(() => setAdding(false))}>
                + @{p.name}
              </button>
            ))}
            {members && addable.length === 0 && <span className="muted small">Every agent is already here.</span>}
          </div>
        ) : (
          <button className="btn small" onClick={() => setAdding(true)}>
            + Add agent
          </button>
        ))}
    </section>
  );
}

function shortId(id: string): string {
  return id.length <= 14 ? id : `${id.slice(0, 6)}…${id.slice(-4)}`;
}

function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 10_000) return `${(n / 1000).toFixed(1)}k`;
  return `${Math.round(n / 1000)}k`;
}

function contextText(run: NonNullable<TeamThreadState["runs"]>[number]): string {
  const used = run.contextTokens;
  const window = run.contextWindow;
  if (used == null && window == null) return "no usage yet";
  const est = run.estimated ? " est." : "";
  if (used != null && window) return `${formatTokens(used)} / ${formatTokens(window)} · ${Math.round((used * 100) / window)}%${est}`;
  if (used != null) return `${formatTokens(used)}${est}`;
  return `window ${formatTokens(window!)}`;
}

function avatarOf(catalog: PersonaRef[], name: string): PersonaAvatar | undefined {
  const key = name.replace(/^@/, "").toLowerCase();
  return catalog.find((p) => p.name.toLowerCase() === key)?.avatar;
}

function Face({
  name,
  host = false,
  agent = false,
  avatar,
  busy = false,
}: {
  name: string;
  host?: boolean;
  agent?: boolean;
  avatar?: PersonaAvatar;
  busy?: boolean;
}) {
  if (host || agent) {
    return (
      <span className={`avatar blob${host ? " bot mark" : ""}`} aria-hidden="true">
        <AgentBlob
          name={host ? BOT_NAME : name}
          avatar={avatar}
          size={32}
          animate={!busy}
          busy={busy}
        />
      </span>
    );
  }
  const letters = name.replace(/^@/, "").slice(0, 2).toUpperCase();
  return (
    <span className="avatar" aria-hidden="true">
      {letters}
    </span>
  );
}

function RunsSection({
  runs,
  catalog,
  onCommand,
}: {
  runs: NonNullable<TeamThreadState["runs"]>;
  catalog: PersonaRef[];
  onCommand?: (text: string) => void;
}) {
  return (
    <section className="runs" aria-label="Agents that ran">
      <h2>Agents</h2>
      {runs.map((run) => {
        const host = run.role === "host";
        const label = host ? BOT_NAME : `@${run.name}`;
        return (
          <details key={`${run.role}:${run.name}`} className={`run ${host ? "" : "agent-tint"}`} style={host ? undefined : agentTint(run.name)} open>
            <summary>
              <Face host={host} agent={!host} name={run.name} avatar={host ? undefined : avatarOf(catalog, run.name)} />
              <span className="run-name">{label}</span>
              <span className="muted small run-hint">{run.session ? shortId(run.session) : "no session"}</span>
            </summary>
            <dl>
              <div>
                <dt>Model</dt>
                <dd>{run.model ?? "default"}</dd>
              </div>
              <div>
                <dt>Session</dt>
                <dd className="mono small" title={run.session ?? undefined}>{run.session ? shortId(run.session) : "no session yet"}</dd>
              </div>
              <div>
                <dt>Context</dt>
                <dd>{contextText(run)}</dd>
              </div>
              {run.turns != null && (
                <div>
                  <dt>Turns</dt>
                  <dd>{run.turns}</dd>
                </div>
              )}
            </dl>
            {onCommand && (
              <div className="run-actions">
                <button
                  type="button"
                  className="btn small"
                  onClick={() => onCommand(host ? "/clear" : `/clear @${run.name}`)}
                >
                  Reset
                </button>
                {host && (
                  <>
                    <button type="button" className="btn small" onClick={() => onCommand("/compact")}>
                      Compact
                    </button>
                    <button type="button" className="btn small" onClick={() => onCommand("/model")}>
                      Model
                    </button>
                  </>
                )}
              </div>
            )}
          </details>
        );
      })}
    </section>
  );
}

function ThreadContextPanel({
  state,
  guest,
  catalog,
  onMember,
  onCommand,
}: {
  state?: TeamThreadState;
  guest: boolean;
  catalog: PersonaRef[];
  onMember?: (op: "add" | "remove", member: MemberChange) => Promise<unknown>;
  onCommand?: (text: string) => void;
}) {
  const wi = state?.workItem;
  const changes = state?.changes;
  return (
    <aside className="play-context" aria-label="Thread context">
      <MembersSection state={state} catalog={catalog} onMember={onMember} />
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
      {!!state?.runs?.length && <RunsSection runs={state.runs} catalog={catalog} onCommand={onCommand} />}

      {(wi || state?.worktree) && <h2>Work item</h2>}
      {!wi && !state?.worktree ? null : wi ? (
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
            <>None yet — ask the agent to create or link one.</>
          )}
        </p>
      )}

      {state?.worktree && <h2>Changes</h2>}
      {!state?.worktree ? null : !changes ? (
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
  if (!link) return <p className="muted small pad">Sharing needs a public tunnel: pick one in Settings › Public tunnel and restart.</p>;
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
