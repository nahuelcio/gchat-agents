import { useEffect, useRef, useState } from "react";
import { agentTint, BOT_NAME } from "../agent-color";
import {
  api,
  type DraftChatMessage,
  type HostDraft,
  type Persona,
  type SkillInfo,
  BUILTIN_MCPS,
  DEFAULT_HOST_MCPS,
  DEFAULT_PERSONA_MCPS,
} from "../api";
import type { ViewProps } from "../App";

type Kind = "agent" | "skill";

const EMPTY_PERSONA: Persona = { name: "", prompt: "", mcps: [...DEFAULT_PERSONA_MCPS] };
const EMPTY_SKILL: SkillInfo = { name: "", description: "", mcps: [], body: "" };

/** Built-in host system prompt (roster line is filled per room at runtime). */
const HOST_BUILTIN_PROMPT = `You are ${BOT_NAME}, the host of this shared chat. People talk to you; other agents are members of the room too.
Agents in this room: (filled from the current room).
When a message is about one of them (even named without @), or their opinion would help, ask them: start a sentence with @name or end it with a question mark. Otherwise just answer yourself.
Every agent here reads every message and answers on its own when it fits. If the message clearly belongs to them and you have nothing to add, reply exactly PASS. If it fits none of them, say so and suggest who should take it.
If a person asks to add an agent back to the room, use the invite_agent tool. Removed agents cannot be called until someone adds them again.`;

const INTRO = {
  host: "This is the main host (Pi / Switchboard) — it can code, use tools, and answer when people talk to the bot. Describe tone, domain rules, never-dos, and which tools/skills it needs. Built-in room/@mention rules stay; your text is layered on top.",
  agent:
    "Tell me what agent you need: domain, tone, whether it listens to every message or only @mentions, and which tools or skills it should use. We can refine it over a few turns.",
  skill:
    "Tell me the procedure you want to package: when it applies, what to do, what never to do, and which tools it needs. We’ll build it across a few messages.",
} as const;

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

function editIntro(kind: Kind, name: string): string {
  return kind === "agent"
    ? `Editing @${name}. Ask for changes (tone, tools, listen…) or edit the draft on the right. Save when it looks right.`
    : `Editing skill “${name}”. Ask for changes to the instructions or tools, or edit the draft on the right. Save when it looks right.`;
}

export function CreateView(props: ViewProps) {
  return (
    <>
      <header className="page-head">
        <div>
          <h1>Create</h1>
          <p className="sub">Create or edit agents and skills — with an AI chat or by hand.</p>
        </div>
      </header>
      <CreateWithAiCard {...props} />
    </>
  );
}

export function CreateWithAiCard({ settings, save, notify }: ViewProps) {
  const personas = settings.personas ?? [];
  const [kind, setKind] = useState<Kind>("agent");
  const [messages, setMessages] = useState<DraftChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [editingHost, setEditingHost] = useState(false);
  const [hostDraft, setHostDraft] = useState<HostDraft | null>(null);
  const [agentDraft, setAgentDraft] = useState<Persona | null>(null);
  const [skillDraft, setSkillDraft] = useState<SkillInfo | null>(null);
  const [editingAgent, setEditingAgent] = useState<string | null>(null);
  const [editingSkill, setEditingSkill] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const bottom = useRef<HTMLDivElement>(null);

  useEffect(() => {
    api.skills().then(setSkills, () => setSkills([]));
  }, []);

  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages, busy]);

  const reset = (next: Kind = kind) => {
    setKind(next);
    setMessages([]);
    setInput("");
    setBusy(false);
    setEditingHost(false);
    setHostDraft(null);
    setAgentDraft(null);
    setSkillDraft(null);
    setEditingAgent(null);
    setEditingSkill(null);
    setReady(false);
  };

  const startEditHost = () => {
    setKind("agent");
    setMessages([]);
    setInput("");
    setBusy(false);
    setEditingHost(true);
    setAgentDraft(null);
    setSkillDraft(null);
    setEditingAgent(null);
    setEditingSkill(null);
    setHostDraft({
      prompt: settings.hostPrompt?.trim() ?? "",
      mcps: settings.hostMcps ?? [...DEFAULT_HOST_MCPS],
      skills: settings.hostSkills ?? [],
    });
    setReady(true);
  };

  const startEditAgent = (p: Persona) => {
    setKind("agent");
    setMessages([]);
    setInput("");
    setBusy(false);
    setEditingHost(false);
    setHostDraft(null);
    setSkillDraft(null);
    setEditingSkill(null);
    setAgentDraft({ ...EMPTY_PERSONA, ...p });
    setEditingAgent(p.name);
    setReady(true);
  };

  const startEditSkill = (sk: SkillInfo) => {
    setKind("skill");
    setMessages([]);
    setInput("");
    setBusy(false);
    setEditingHost(false);
    setHostDraft(null);
    setAgentDraft(null);
    setEditingAgent(null);
    setSkillDraft({ ...EMPTY_SKILL, ...sk });
    setEditingSkill(sk.name);
    setReady(true);
  };

  const startBlank = () => {
    setMessages([]);
    setEditingHost(false);
    setHostDraft(null);
    if (kind === "agent") {
      setAgentDraft({ ...EMPTY_PERSONA });
      setEditingAgent(null);
      setReady(false);
    } else {
      setSkillDraft({ ...EMPTY_SKILL });
      setEditingSkill(null);
      setReady(false);
    }
  };

  const send = () => {
    const text = input.trim();
    if (!text || busy) return;
    const nextMessages: DraftChatMessage[] = [...messages, { role: "user", content: text }];
    setMessages(nextMessages);
    setInput("");
    setBusy(true);
    const finish = (message: string, readyFlag: boolean, apply: () => void) => {
      setMessages((m) => [...m, { role: "assistant", content: message }]);
      setReady(readyFlag);
      apply();
    };
    const onErr = (e: Error) => notify(e.message, true);

    if (editingHost) {
      api
        .draftHostChat(nextMessages, hostDraft ?? undefined)
        .then((reply) =>
          finish(reply.message, Boolean(reply.ready) || Boolean(reply.draft) || Boolean(hostDraft), () => {
            if (reply.draft) {
              setHostDraft({
                prompt: reply.draft.prompt ?? hostDraft?.prompt ?? "",
                mcps: reply.draft.mcps ?? hostDraft?.mcps ?? [...DEFAULT_HOST_MCPS],
                skills: reply.draft.skills ?? hostDraft?.skills ?? [],
              });
            }
          }),
        )
        .catch(onErr)
        .finally(() => setBusy(false));
      return;
    }
    if (kind === "agent") {
      api
        .draftAgentChat(nextMessages, agentDraft ?? undefined)
        .then((reply) =>
          finish(reply.message, Boolean(reply.ready) || Boolean(reply.draft) || Boolean(agentDraft), () => {
            if (reply.draft) {
              const next = { ...EMPTY_PERSONA, ...reply.draft };
              if (editingAgent) next.name = editingAgent;
              setAgentDraft(next);
            }
          }),
        )
        .catch(onErr)
        .finally(() => setBusy(false));
      return;
    }
    api
      .draftSkillChat(nextMessages, skillDraft ?? undefined)
      .then((reply) =>
        finish(reply.message, Boolean(reply.ready) || Boolean(reply.draft) || Boolean(skillDraft), () => {
          if (reply.draft) {
            const next = { ...EMPTY_SKILL, ...reply.draft };
            if (editingSkill) next.name = editingSkill;
            setSkillDraft(next);
          }
        }),
      )
      .catch(onErr)
      .finally(() => setBusy(false));
  };

  const saveHost = () => {
    const prompt = hostDraft?.prompt.trim() ?? "";
    const mcps = hostDraft?.mcps ?? [...DEFAULT_HOST_MCPS];
    const skills = hostDraft?.skills ?? [];
    void save(
      { hostPrompt: prompt, hostMcps: mcps, hostSkills: skills },
      prompt || mcps.length || skills.length ? "Host agent saved" : "Host agent cleared",
    ).then(() => {
      notify("Host agent updated");
      reset("agent");
    });
  };

  const saveAgent = () => {
    if (!agentDraft?.name.trim() || !agentDraft.prompt.trim()) return;
    const draft = cleanPersona(agentDraft);
    if (editingAgent) draft.name = editingAgent;
    const list = [...personas];
    const orig = editingAgent?.toLowerCase();
    const idx = orig ? list.findIndex((p) => p.name.toLowerCase() === orig) : list.findIndex((p) => p.name.toLowerCase() === draft.name.toLowerCase());
    if (orig && idx < 0) {
      notify(`@${editingAgent} no longer exists`, true);
      return;
    }
    if (!orig && idx >= 0) {
      notify(`@${draft.name} already exists — open it with Edit`, true);
      return;
    }
    if (idx >= 0) list[idx] = draft;
    else list.push(draft);
    void save({ personas: list }, `@${draft.name} saved`).then(() => {
      notify(idx >= 0 ? `@${draft.name} updated` : `@${draft.name} created`);
      reset("agent");
    });
  };

  const removeAgent = (name: string) => {
    void save(
      { personas: personas.filter((p) => p.name.toLowerCase() !== name.toLowerCase()) },
      `@${name} removed`,
    ).then(() => {
      if (editingAgent?.toLowerCase() === name.toLowerCase()) reset("agent");
    });
  };

  const saveSkill = () => {
    if (!skillDraft?.name.trim() || !skillDraft.body.trim()) return;
    const skill = {
      ...skillDraft,
      name: (editingSkill ?? skillDraft.name).trim().toLowerCase(),
      description: skillDraft.description.trim() || skillDraft.name.trim(),
    };
    void api.saveSkill(skill).then(
      (list) => {
        setSkills(list);
        notify(editingSkill ? `Skill ${skill.name} updated` : `Skill ${skill.name} saved`);
        reset("skill");
      },
      (e: Error) => notify(e.message, true),
    );
  };

  const removeSkill = (name: string) => {
    void api.deleteSkill(name).then(
      (list) => {
        setSkills(list);
        notify(`Skill ${name} deleted`);
        if (editingSkill === name) reset("skill");
      },
      (e: Error) => notify(e.message, true),
    );
  };

  const toolNames = [
    ...new Set(["engram", ...BUILTIN_MCPS.map((m) => m.name), ...(settings.mcpServers ?? []).map((m) => m.name)]),
  ];
  const intro = editingHost
    ? settings.hostPrompt?.trim()
      ? "Editing the host system prompt. Ask for changes or edit the draft on the right. Save when it looks right."
      : INTRO.host
    : kind === "agent" && editingAgent
      ? editIntro("agent", editingAgent)
      : kind === "skill" && editingSkill
        ? editIntro("skill", editingSkill)
        : INTRO[kind];
  const editing = editingHost || Boolean(editingAgent || editingSkill);
  const hasDraft = Boolean(hostDraft || agentDraft || skillDraft);
  const hostTools = settings.hostMcps ?? [...DEFAULT_HOST_MCPS];
  const hostSnippet = [
    hostTools.length ? `tools: ${hostTools.join(", ")}` : "all tools",
    settings.hostSkills?.length ? `skills: ${settings.hostSkills.join(", ")}` : "",
    settings.hostPrompt?.trim()
      ? settings.hostPrompt.trim().slice(0, 80) + (settings.hostPrompt.trim().length > 80 ? "…" : "")
      : "default host preamble",
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <details className="card" open>
      <summary className="card-title">
        <h2>Agents & skills</h2>
        <p className="muted small">List, edit by hand, or refine with the AI chat. The host is always present and cannot be deleted.</p>
      </summary>

      <div className="create-ai-kinds" role="tablist" aria-label="What to manage">
        <button type="button" role="tab" aria-selected={kind === "agent"} className={kind === "agent" ? "on" : ""} onClick={() => reset("agent")}>
          Agents
        </button>
        <button type="button" role="tab" aria-selected={kind === "skill"} className={kind === "skill" ? "on" : ""} onClick={() => reset("skill")}>
          Skills
        </button>
      </div>

      <section className="create-ai-catalog" aria-label={kind === "agent" ? "Agents" : "Skills"}>
        {kind === "agent" ? (
          <>
            <div className={`persona-row${editingHost ? " on" : ""}`}>
              <div className="grow">
                <span className="strong">Host (Pi)</span>
                <span className="muted small">{hostSnippet}</span>
              </div>
              <button className="btn small" type="button" onClick={startEditHost}>
                Edit
              </button>
            </div>
            {personas.map((p) => (
              <div key={p.name} className={`persona-row${editingAgent === p.name ? " on" : ""}`}>
                <div className="grow">
                  <span className="strong agent-tint author" style={agentTint(p.name)}>
                    @{p.name}
                  </span>
                  <span className="muted small">{p.prompt ? p.prompt.slice(0, 100) + (p.prompt.length > 100 ? "…" : "") : "No role yet"}</span>
                </div>
                <button className="btn small" type="button" onClick={() => startEditAgent(p)}>
                  Edit
                </button>
                <button className="btn small" type="button" aria-label={`Remove @${p.name}`} onClick={() => removeAgent(p.name)}>
                  Delete
                </button>
              </div>
            ))}
          </>
        ) : skills.length === 0 ? (
          <p className="empty">No skills yet.</p>
        ) : (
          skills.map((sk) => (
            <div key={sk.name} className={`persona-row${editingSkill === sk.name ? " on" : ""}`}>
              <div className="grow">
                <span className="strong">{sk.name}</span>
                <span className="muted small">{sk.description}</span>
              </div>
              <button className="btn small" type="button" onClick={() => startEditSkill(sk)}>
                Edit
              </button>
              <button className="btn small" type="button" aria-label={`Delete skill ${sk.name}`} onClick={() => removeSkill(sk.name)}>
                Delete
              </button>
            </div>
          ))
        )}
        <div className="row" style={{ flexWrap: "wrap", gap: "0.5rem" }}>
          <button className="btn" type="button" onClick={startBlank}>
            + New {kind === "agent" ? "agent" : "skill"} (manual)
          </button>
          <button className="btn" type="button" onClick={() => reset(kind)}>
            + New with AI
          </button>
        </div>
      </section>

      <div className="create-ai-layout">
        <section className="create-ai-chat" aria-label="Creation chat">
          <div className="create-ai-thread">
            <div className="create-ai-msg assistant">
              <span className="create-ai-role">AI</span>
              <p>{intro}</p>
            </div>
            {messages.map((m, i) => (
              <div key={`${m.role}-${i}`} className={`create-ai-msg ${m.role}`}>
                <span className="create-ai-role">{m.role === "user" ? "You" : "AI"}</span>
                <p>{m.content}</p>
              </div>
            ))}
            {busy && (
              <div className="create-ai-msg assistant muted">
                <span className="create-ai-role">AI</span>
                <p>Thinking…</p>
              </div>
            )}
            <div ref={bottom} />
          </div>
          <form
            className="create-ai-composer"
            onSubmit={(e) => {
              e.preventDefault();
              send();
            }}
          >
            <textarea
              rows={2}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  send();
                }
              }}
              placeholder={
                editingHost
                  ? "e.g. stay concise, prefer Spanish, route billing to @finanzas…"
                  : editing
                    ? "e.g. make it shorter and use Drive…"
                    : kind === "agent"
                      ? "e.g. B2B sales agent that quotes from Drive…"
                      : "e.g. pricing skill with discount rules…"
              }
              disabled={busy}
              aria-label="Message"
            />
            <div className="row">
              <button className="btn primary" disabled={!input.trim() || busy}>
                {busy ? "…" : "Send"}
              </button>
              <button type="button" className="btn" disabled={busy || (messages.length === 0 && !hasDraft)} onClick={() => reset(kind)}>
                Reset
              </button>
            </div>
          </form>
        </section>

        <section className="create-ai-draft" aria-label="Draft">
          <div className="create-ai-draft-head">
            <h3>{editingHost ? "Host system prompt" : editingAgent || editingSkill ? "Editing" : "Draft"}</h3>
            {editingHost ? (
              <span className="pill accent">Host</span>
            ) : editingAgent || editingSkill ? (
              <span className="pill accent">{editingAgent ? `@${editingAgent}` : editingSkill}</span>
            ) : ready ? (
              <span className="pill ok">Ready to save</span>
            ) : (
              <span className="pill">In conversation</span>
            )}
          </div>

          {editingHost ? (
            hostDraft ? (
              <form
                className="persona-form"
                onSubmit={(e) => {
                  e.preventDefault();
                  saveHost();
                }}
              >
                <label className="field">
                  <span>Built-in system prompt</span>
                  <textarea className="mono" rows={8} value={HOST_BUILTIN_PROMPT} readOnly aria-readonly="true" />
                  <span className="muted small">Always applied. The agents line is filled from the room at runtime.</span>
                </label>
                <label className="field">
                  <span>Extra system prompt</span>
                  <textarea
                    rows={6}
                    value={hostDraft.prompt}
                    onChange={(e) => setHostDraft({ ...hostDraft, prompt: e.target.value })}
                    placeholder="Optional layer on top: tone, domain rules, never-dos…"
                  />
                  <span className="muted small">
                    Appended after the built-in prompt. Applies on the next fresh host session (/clear).
                  </span>
                </label>
                {skills.length > 0 && (
                  <fieldset className="field">
                    <legend>Skill packs</legend>
                    {skills.map((sk) => (
                      <label key={sk.name} className="inline check">
                        <input
                          type="checkbox"
                          checked={(hostDraft.skills ?? []).includes(sk.name)}
                          onChange={() => {
                            const cur = hostDraft.skills ?? [];
                            setHostDraft({
                              ...hostDraft,
                              skills: cur.includes(sk.name) ? cur.filter((x) => x !== sk.name) : [...cur, sk.name],
                            });
                          }}
                        />
                        <span>{sk.name}</span>
                      </label>
                    ))}
                  </fieldset>
                )}
                <fieldset className="field">
                  <legend>Tools</legend>
                  {toolNames.map((name) => (
                    <label key={name} className="inline check">
                      <input
                        type="checkbox"
                        checked={(hostDraft.mcps ?? []).includes(name)}
                        onChange={() => {
                          const cur = hostDraft.mcps ?? [];
                          setHostDraft({
                            ...hostDraft,
                            mcps: cur.includes(name) ? cur.filter((x) => x !== name) : [...cur, name],
                          });
                        }}
                      />
                      <span>{name}</span>
                    </label>
                  ))}
                  <span className="muted small">None checked = every tool. Default is coding, switchboard, engram, agents, google-drive.</span>
                </fieldset>
                <div className="row">
                  <button className="btn primary">Save host</button>
                  <button type="button" className="btn" onClick={() => reset("agent")}>
                    Cancel
                  </button>
                </div>
              </form>
            ) : (
              <p className="empty">Pick Edit on Host (Pi) to load the prompt editor.</p>
            )
          ) : kind === "agent" ? (
            agentDraft ? (
              <form
                className="persona-form"
                onSubmit={(e) => {
                  e.preventDefault();
                  saveAgent();
                }}
              >
                <label className="field narrow">
                  <span>Name</span>
                  <input
                    className="mono"
                    value={agentDraft.name}
                    onChange={(e) => setAgentDraft({ ...agentDraft, name: e.target.value })}
                    disabled={Boolean(editingAgent)}
                    required
                  />
                </label>
                <label className="field">
                  <span>Role</span>
                  <textarea
                    rows={5}
                    value={agentDraft.prompt}
                    onChange={(e) => setAgentDraft({ ...agentDraft, prompt: e.target.value })}
                    required
                  />
                </label>
                <div className="row">
                  <label className="field grow">
                    <span>Listens</span>
                    <select
                      value={agentDraft.listen ?? "mentions"}
                      onChange={(e) => setAgentDraft({ ...agentDraft, listen: e.target.value === "all" ? "all" : undefined })}
                    >
                      <option value="mentions">Only @mentions</option>
                      <option value="all">Every message</option>
                    </select>
                  </label>
                  <label className="field grow">
                    <span>Answers</span>
                    <select
                      value={agentDraft.respondTo ?? "anyone"}
                      onChange={(e) => setAgentDraft({ ...agentDraft, respondTo: e.target.value === "people" ? "people" : undefined })}
                    >
                      <option value="anyone">Anyone</option>
                      <option value="people">Only people</option>
                    </select>
                  </label>
                </div>
                {skills.length > 0 && (
                  <fieldset className="field">
                    <legend>Skill packs</legend>
                    {skills.map((sk) => (
                      <label key={sk.name} className="inline check">
                        <input
                          type="checkbox"
                          checked={(agentDraft.skills ?? []).includes(sk.name)}
                          onChange={() => {
                            const cur = agentDraft.skills ?? [];
                            setAgentDraft({
                              ...agentDraft,
                              skills: cur.includes(sk.name) ? cur.filter((x) => x !== sk.name) : [...cur, sk.name],
                            });
                          }}
                        />
                        <span>{sk.name}</span>
                      </label>
                    ))}
                  </fieldset>
                )}
                <fieldset className="field">
                  <legend>Tools</legend>
                  {toolNames.map((name) => (
                    <label key={name} className="inline check">
                      <input
                        type="checkbox"
                        checked={(agentDraft.mcps ?? []).includes(name)}
                        onChange={() => {
                          const cur = agentDraft.mcps ?? [];
                          setAgentDraft({
                            ...agentDraft,
                            mcps: cur.includes(name) ? cur.filter((x) => x !== name) : [...cur, name],
                          });
                        }}
                      />
                      <span>{name}</span>
                    </label>
                  ))}
                </fieldset>
                <div className="row">
                  <button className="btn primary" disabled={!agentDraft.name.trim() || !agentDraft.prompt.trim()}>
                    {editingAgent ? "Save changes" : "Save agent"}
                  </button>
                  {editingAgent && (
                    <button type="button" className="btn" onClick={() => reset("agent")}>
                      Cancel
                    </button>
                  )}
                </div>
              </form>
            ) : (
              <p className="empty">Pick Edit above, or chat / create a new one to see the draft here.</p>
            )
          ) : skillDraft ? (
            <form
              className="persona-form"
              onSubmit={(e) => {
                e.preventDefault();
                saveSkill();
              }}
            >
              <label className="field">
                <span>Name</span>
                <input
                  value={skillDraft.name}
                  onChange={(e) => setSkillDraft({ ...skillDraft, name: e.target.value })}
                  disabled={Boolean(editingSkill)}
                  required
                />
              </label>
              <label className="field">
                <span>Description</span>
                <input
                  value={skillDraft.description}
                  onChange={(e) => setSkillDraft({ ...skillDraft, description: e.target.value })}
                />
              </label>
              <fieldset className="field">
                <legend>Needs tools</legend>
                {toolNames.map((g) => (
                  <label key={g} className="inline check">
                    <input
                      type="checkbox"
                      checked={skillDraft.mcps.includes(g)}
                      onChange={() =>
                        setSkillDraft({
                          ...skillDraft,
                          mcps: skillDraft.mcps.includes(g) ? skillDraft.mcps.filter((x) => x !== g) : [...skillDraft.mcps, g],
                        })
                      }
                    />
                    <span>{g}</span>
                  </label>
                ))}
              </fieldset>
              <label className="field">
                <span>Instructions</span>
                <textarea rows={8} value={skillDraft.body} onChange={(e) => setSkillDraft({ ...skillDraft, body: e.target.value })} required />
              </label>
              <div className="row">
                <button className="btn primary" disabled={!skillDraft.name.trim() || !skillDraft.body.trim()}>
                  {editingSkill ? "Save changes" : "Save skill"}
                </button>
                {editingSkill && (
                  <button type="button" className="btn" onClick={() => reset("skill")}>
                    Cancel
                  </button>
                )}
              </div>
            </form>
          ) : (
            <p className="empty">Pick Edit above, or chat / create a new one to see the draft here.</p>
          )}
        </section>
      </div>
    </details>
  );
}
