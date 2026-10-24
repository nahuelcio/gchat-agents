import { useEffect, useRef, useState } from "react";
import { AgentBlob, AvatarPicker, avatarFromName } from "../AgentBlob";
import { agentTint, BOT_NAME } from "../agent-color";
import {
  api,
  type DraftChatMessage,
  type HostDraft,
  type McpServer,
  type Persona,
  type PersonaTemplate,
  type SkillFile,
  type SkillInfo,
  type SkillSearchHit,
  BUILTIN_MCPS,
  DEFAULT_HOST_MCPS,
  DEFAULT_HOST_SKILLS,
  DEFAULT_PERSONA_MCPS,
} from "../api";
import { hashQuery, type ViewProps } from "../App";
import { CodeEditor } from "../LazyCodeEditor";
import { AgentModelField } from "../AgentModelField";

type Kind = "agent" | "skill";

const EMPTY_PERSONA: Persona = { name: "", prompt: "", mcps: [...DEFAULT_PERSONA_MCPS] };
const EMPTY_SKILL: SkillInfo = { name: "", description: "", mcps: [], body: "", files: [] };

function formatInstalls(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1).replace(/\.0$/, "")}K`;
  return String(n);
}

const SKILL_TOPICS = ["react", "testing", "design", "git", "docs", "security", "sql", "python", "rust", "devops", "review", "pdf"];

function skillInstallSpec(hit: SkillSearchHit): string {
  return `${hit.source}@${hit.skillId}`;
}

const STARTERS: {
  id: string;
  name: string;
  label: string;
  blurb: string;
  skill: string;
  mcps: string[];
  prompt: string;
}[] = [];

const SCRIPT_STUBS: Record<string, { path: string; content: string }> = {
  js: {
    path: "scripts/format-pdf.js",
    content: `#!/usr/bin/env node
/**
 * Custom skill tool — example: format / transform a PDF (or any file).
 * Usage: node scripts/format-pdf.js <input> <output>
 * Replace the body with your real logic (pdf-lib, puppeteer, etc.).
 */
const [,, input, output] = process.argv;
if (!input || !output) {
  console.error("Usage: node scripts/format-pdf.js <input> <output>");
  process.exit(1);
}
console.log(JSON.stringify({ ok: true, input, output, note: "stub — implement me" }));
`,
  },
  py: {
    path: "scripts/format_pdf.py",
    content: `#!/usr/bin/env python3
"""Custom skill tool — example PDF/file transform. Usage: python scripts/format_pdf.py <input> <output>"""
import json, sys
if len(sys.argv) < 3:
    print("Usage: python scripts/format_pdf.py <input> <output>", file=sys.stderr)
    sys.exit(1)
print(json.dumps({"ok": True, "input": sys.argv[1], "output": sys.argv[2], "note": "stub — implement me"}))
`,
  },
};

function ensureCoding(mcps: string[]): string[] {
  return mcps.includes("coding") ? mcps : [...mcps, "coding"];
}

const HOST_DEFAULT_PROMPT = `You are ${BOT_NAME}, the host of this shared chat. People talk to you; other agents are members of the room too.
When a message is about one of them (even named without @), or their opinion would help, ask them: start a sentence with @name or end it with a question mark. Otherwise just answer yourself.
Every agent here reads every message and answers on its own when it fits. If the message clearly belongs to them and you have nothing to add, reply exactly PASS. If it fits none of them, say so and suggest who should take it.
If a person asks to add an agent back to the room, use the invite_agent tool. Removed agents cannot be called until someone adds them again.`;

const INTRO = {
  host: "e.g. prefer Spanish, keep all tools, shorter replies…",
  agent: "e.g. B2B sales agent that quotes from Drive…",
  skill: "e.g. pricing skill with discount rules and a JS helper…",
  editAgent: (name: string) => `e.g. make @${name} shorter, add Drive, only answer people…`,
  editSkill: (name: string) =>
    name === "skill-creator"
      ? "e.g. tighten never-dos for Create → Skills…"
      : `e.g. add references/sla.md, tighten “${name}”…`,
} as const;

function cleanPersona(raw: Persona): Persona {
  const draft: Persona = { ...raw, name: raw.name.trim().replace(/^@/, ""), prompt: raw.prompt.trim() };
  if (!draft.skills?.length) delete draft.skills;
  if (!draft.mcps?.length) delete draft.mcps;
  if (!draft.delegates?.length || !draft.mcps?.includes("agents")) delete draft.delegates;
  if (!draft.model?.trim()) delete draft.model;
  if (draft.listen !== "all") delete draft.listen;
  if (draft.respondTo !== "people") delete draft.respondTo;
  if (!draft.avatar?.color) delete draft.avatar;
  return draft;
}

function templateIdFrom(name: string, existing: PersonaTemplate[]): string {
  const root =
    (name || "template")
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

function ToggleChips({
  options,
  selected,
  onToggle,
  emptyHint,
}: {
  options: { id: string; label: string }[];
  selected: string[];
  onToggle: (id: string) => void;
  emptyHint?: string;
}) {
  if (options.length === 0) return emptyHint ? <p className="muted small">{emptyHint}</p> : null;
  return (
    <div className="create-ai-chips" role="group">
      {options.map((o) => (
        <button
          key={o.id}
          type="button"
          className={`chip ${selected.includes(o.id) ? "on" : ""}`}
          aria-pressed={selected.includes(o.id)}
          onClick={() => onToggle(o.id)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function CreateView(props: ViewProps) {
  return (
    <>
      <header className="page-head">
        <div>
          <h1>Agents</h1>
          <p className="sub">Agents and skills — edit the form, or refine with AI.</p>
        </div>
      </header>
      <CreateWithAiCard {...props} />
    </>
  );
}

export function CreateWithAiCard({ settings, save, setSettings, notify }: ViewProps) {
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
  const [piGroups, setPiGroups] = useState<{ id: string; label: string }[]>([]);
  useEffect(() => {
    api.piPackages().then((list) => setPiGroups(list.filter((p) => p.tools.length).map((p) => ({ id: p.group, label: `${p.group} — pi package ${p.name}` }))), () => {});
  }, []);
  const [aiOpen, setAiOpen] = useState(false);
  const [skillSource, setSkillSource] = useState("");
  const [installing, setInstalling] = useState(false);
  const [installingSpec, setInstallingSpec] = useState<string | null>(null);
  const [skillSearch, setSkillSearch] = useState("");
  const [skillOwner, setSkillOwner] = useState("");
  const [skillHits, setSkillHits] = useState<SkillSearchHit[]>([]);
  const [skillSearching, setSkillSearching] = useState(false);
  const [starterBusy, setStarterBusy] = useState<string | null>(null);
  const starterHandled = useRef<string | null>(null);
  const bottom = useRef<HTMLDivElement>(null);

  useEffect(() => {
    api.skills().then(setSkills, () => setSkills([]));
  }, []);

  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages, busy]);

  useEffect(() => {
    const q = skillSearch.trim();
    const owner = skillOwner.trim();
    if (q.length < 2 && owner.length < 2) {
      setSkillHits([]);
      setSkillSearching(false);
      return;
    }
    setSkillSearching(true);
    const t = window.setTimeout(() => {
      api
        .searchSkills(q, { owner: owner || undefined, limit: 40 })
        .then(
          ({ skills: hits }) => setSkillHits(hits),
          () => setSkillHits([]),
        )
        .finally(() => setSkillSearching(false));
    }, 280);
    return () => window.clearTimeout(t);
  }, [skillSearch, skillOwner]);

  const installFromSpec = (spec: string) => {
    if (!spec || installing) return;
    setInstalling(true);
    setInstallingSpec(spec);
    api
      .installSkill(spec)
      .then(
        ({ installed, skills: list }) => {
          setSkills(list);
          setSkillSource("");
          notify(installed.length ? `Installed ${installed.join(", ")}` : "Nothing new to install");
        },
        (err: Error) => notify(err.message, true),
      )
      .finally(() => {
        setInstalling(false);
        setInstallingSpec(null);
      });
  };

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
    setAiOpen(false);
    setSkillSearch("");
    setSkillOwner("");
    setSkillHits([]);
  };

  const revealEditor = () => {
    if (!matchMedia("(max-width: 960px)").matches) return;
    requestAnimationFrame(() => document.querySelector(".create-ai-layout")?.scrollIntoView({ block: "start" }));
  };

  const startEditHost = (withAi = false) => {
    setKind("agent");
    setMessages([]);
    setInput("");
    setBusy(false);
    setEditingHost(true);
    setAgentDraft(null);
    setSkillDraft(null);
    setEditingAgent(null);
    setEditingSkill(null);
    {
      const saved = settings.hostPrompt?.trim() ?? "";
      const prompt = !saved
        ? HOST_DEFAULT_PROMPT
        : saved.startsWith(`You are ${BOT_NAME}`)
          ? saved
          : `${HOST_DEFAULT_PROMPT}\n\n${saved}`;
      setHostDraft({
        prompt,
        mcps: settings.hostMcps?.length ? settings.hostMcps : [...DEFAULT_HOST_MCPS],
        skills: settings.hostSkills?.length ? settings.hostSkills : [...DEFAULT_HOST_SKILLS],
      });
    }
    setReady(true);
    setAiOpen(withAi);
    revealEditor();
  };

  const startEditAgent = (p: Persona, withAi = false) => {
    setKind("agent");
    setMessages([]);
    setInput("");
    setBusy(false);
    setEditingHost(false);
    setHostDraft(null);
    setSkillDraft(null);
    setEditingSkill(null);
    setAgentDraft({ ...EMPTY_PERSONA, ...p, avatar: p.avatar ?? avatarFromName(p.name) });
    setEditingAgent(p.name);
    setReady(true);
    setAiOpen(withAi);
    revealEditor();
  };

  const startEditSkill = (sk: SkillInfo, withAi = false) => {
    setKind("skill");
    setMessages([]);
    setInput("");
    setBusy(false);
    setEditingHost(false);
    setHostDraft(null);
    setAgentDraft(null);
    setEditingAgent(null);
    setSkillDraft({ ...EMPTY_SKILL, ...sk, files: sk.files ?? [] });
    setEditingSkill(sk.name);
    setReady(true);
    setAiOpen(withAi);
    revealEditor();
  };

  const startBlank = () => {
    setMessages([]);
    setEditingHost(false);
    setHostDraft(null);
    setAiOpen(false);
    if (kind === "agent") {
      setAgentDraft({ ...EMPTY_PERSONA, avatar: avatarFromName("agent") });
      setEditingAgent(null);
      setReady(false);
    } else {
      setSkillDraft({ ...EMPTY_SKILL });
      setEditingSkill(null);
      setReady(false);
    }
  };

  const startWithAi = () => {
    reset(kind);
    setAiOpen(true);
  };

  const applyStarter = (id: string) => {
    const starter = STARTERS.find((s) => s.id === id);
    if (!starter || starterBusy) return;
    const exists = personas.some((p) => p.name.toLowerCase() === starter.name.toLowerCase());
    if (exists) {
      const p = personas.find((x) => x.name.toLowerCase() === starter.name.toLowerCase())!;
      startEditAgent(p, false);
      notify(`@${starter.name} already exists — opened for edit`);
      return;
    }
    setStarterBusy(starter.id);
    api
      .skills()
      .then((list) => {
        setSkills(list);
        if (!list.some((s) => s.name === starter.skill)) {
          notify(`Skill “${starter.skill}” is not available on this machine`, true);
          return;
        }
        const draft = cleanPersona({
          ...EMPTY_PERSONA,
          name: starter.name,
          prompt: starter.prompt,
          skills: [starter.skill],
          mcps: starter.mcps,
          avatar: avatarFromName(starter.name),
        });
        return save({ personas: [...personas, draft] }, `@${draft.name} ready — invite them in team chat`).then(() => {
          reset("agent");
        });
      }, (e: Error) => notify(e.message, true))
      .finally(() => setStarterBusy(null));
  };

  useEffect(() => {
    const starter = hashQuery().get("starter");
    if (!starter || starterHandled.current === starter) return;
    starterHandled.current = starter;
    applyStarter(starter);
    // Clear query so refresh does not re-apply.
    history.replaceState(null, "", "#create");
    // eslint-disable-next-line react-hooks/exhaustive-deps -- run once per deep-link
  }, []);

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
                mcps: reply.draft.mcps ?? hostDraft?.mcps ?? [],
                skills: reply.draft.skills ?? hostDraft?.skills ?? [...DEFAULT_HOST_SKILLS],
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
              setAgentDraft((prev) => {
                const next = { ...EMPTY_PERSONA, ...prev, ...reply.draft };
                if (editingAgent) next.name = editingAgent;
                if (!next.avatar) next.avatar = prev?.avatar ?? avatarFromName(next.name || "agent");
                return next;
              });
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
            setSkillDraft((prev) => {
              const next = { ...EMPTY_SKILL, ...prev, ...reply.draft, files: reply.draft?.files ?? prev?.files ?? [] };
              if (editingSkill) next.name = editingSkill;
              return next;
            });
          }
        }),
      )
      .catch(onErr)
      .finally(() => setBusy(false));
  };

  const saveHost = () => {
    const prompt = hostDraft?.prompt.trim() ?? "";
    const mcps = hostDraft?.mcps ?? [];
    const hostSkills = hostDraft?.skills?.length ? hostDraft.skills : [...DEFAULT_HOST_SKILLS];
    void save({ hostPrompt: prompt || null, hostMcps: mcps, hostSkills }, "Host agent saved").then(() => {
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
    if (!confirm(`Delete @${name}? Threads keep its past messages.`)) return;
    void save(
      { personas: personas.filter((p) => p.name.toLowerCase() !== name.toLowerCase()) },
      `@${name} removed`,
    ).then(() => {
      if (editingAgent?.toLowerCase() === name.toLowerCase()) reset("agent");
    });
  };

  const exportAgent = (p: Persona) => {
    const used = new Set(p.skills ?? []);
    const servers = (settings.mcpServers ?? [])
      .filter((m) => p.mcps?.includes(m.name))
      .map((m) => ({ ...m, env: m.env ? Object.fromEntries(Object.keys(m.env).map((k) => [k, ""])) : undefined }));
    const bundle = {
      switchboardAgent: 1,
      persona: cleanPersona(p),
      skills: skills.filter((s) => used.has(s.name)),
      mcpServers: servers,
    };
    const url = URL.createObjectURL(new Blob([JSON.stringify(bundle, null, 2)], { type: "application/json" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `${p.name.toLowerCase()}.agent.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const importAgents = async (files: FileList) => {
    let list = [...personas];
    let servers = [...(settings.mcpServers ?? [])];
    const names: string[] = [];
    const blanks: string[] = [];
    try {
      for (const file of [...files]) {
        const raw = JSON.parse(await file.text()) as { switchboardAgent?: number; persona?: Persona; skills?: SkillInfo[]; mcpServers?: McpServer[] };
        const persona = raw.persona ?? (raw as unknown as Persona);
        if (!persona?.name || !persona.prompt) throw new Error(`${file.name} is not an agent export`);
        const have = new Set(skills.map((s) => s.name));
        for (const sk of raw.skills ?? []) {
          if (!have.has(sk.name)) await api.saveSkill(sk).then(setSkills);
        }
        for (const m of raw.mcpServers ?? []) {
          if (servers.some((s) => s.name === m.name)) continue;
          servers.push(m);
          if (Object.values(m.env ?? {}).some((v) => !v)) blanks.push(m.name);
        }
        const next = cleanPersona(persona);
        list = [...list.filter((x) => x.name.toLowerCase() !== next.name.toLowerCase()), next];
        names.push(`@${next.name}`);
      }
    } catch (e) {
      notify(e instanceof Error ? e.message : "Import failed", true);
      return;
    }
    await save({ personas: list, mcpServers: servers }, `Imported ${names.join(", ")}`);
    if (blanks.length) notify(`Fill the keys for ${blanks.join(", ")} in Settings › Tools.`);
  };

  const saveSkill = () => {
    if (!skillDraft?.name.trim() || !skillDraft.body.trim()) return;
    const files = (skillDraft.files ?? []).filter((f) => f.path.trim() && f.content.trim());
    const hasScripts = files.some((f) => f.path.startsWith("scripts/"));
    const skill: SkillInfo = {
      ...skillDraft,
      name: (editingSkill ?? skillDraft.name).trim().toLowerCase(),
      description: skillDraft.description.trim() || skillDraft.name.trim(),
      mcps: hasScripts ? ensureCoding(skillDraft.mcps) : skillDraft.mcps,
      files,
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
    if (!confirm(`Delete skill ${name}?`)) return;
    void api.deleteSkill(name).then(
      (list) => {
        setSkills(list);
        notify(`Skill ${name} deleted`);
        if (editingSkill === name) reset("skill");
      },
      (e: Error) => notify(e.message, true),
    );
  };

  const toolLabels = new Map<string, string>([
    ...BUILTIN_MCPS.map((m) => [m.name, m.label] as const),
    ...(settings.mcpServers ?? []).map((m) => [m.name, `${m.name} — custom MCP`] as const),
    ["engram", "engram — your MCP server"] as const,
    ["context7", "context7 — up-to-date library docs"] as const,
  ]);
  const toolNames = [
    ...new Set(["engram", "context7", ...BUILTIN_MCPS.map((m) => m.name), ...(settings.mcpServers ?? []).map((m) => m.name)]),
  ];
  const toolOpts = [...toolNames.map((id) => ({ id, label: toolLabels.get(id) ?? id })), ...piGroups];
  // skill-creator steers Create AI; don't attach it to agents/host.
  const attachableSkills = skills.filter((s) => s.name !== "skill-creator");
  const skillOpts = attachableSkills.map((s) => ({
    id: s.name,
    label: s.mcps.length ? `${s.name} (${s.mcps.join(", ")})` : s.name,
  }));
  const templates = settings.templates ?? [];
  const canAsk = (agentDraft?.mcps ?? []).includes("agents");
  const peerAgents = personas.filter((p) => p.name.toLowerCase() !== (agentDraft?.name || editingAgent || "").toLowerCase());

  const toggleAgentTools = (id: string) => {
    if (!agentDraft) return;
    const mcps = toggleList(agentDraft.mcps, id);
    const next: Persona = { ...agentDraft, mcps };
    if (!mcps.includes("agents")) delete next.delegates;
    setAgentDraft(next);
  };

  const saveAsTemplate = () => {
    if (!agentDraft) return;
    const cleaned = cleanPersona(agentDraft);
    if (!cleaned.name || !cleaned.prompt) return;
    const id = templateIdFrom(cleaned.name, templates);
    const tpl: PersonaTemplate = { id, ...cleaned };
    void save({ templates: [...templates, tpl] }, `Template ${id} saved`).then(() => notify(`Template ${id} saved`));
  };

  const applyTemplate = (t: PersonaTemplate) => {
    const next = personaFromTemplate(t);
    const list = [...personas];
    const idx = list.findIndex((p) => p.name.toLowerCase() === next.name.toLowerCase());
    if (idx >= 0) list[idx] = next;
    else list.push(next);
    void save({ personas: list }, `@${next.name} from template`).then(async () => {
      notify(idx >= 0 ? `@${next.name} updated from template` : `@${next.name} created from template`);
      startEditAgent(next);
      const installed = new Set((settings.mcpServers ?? []).map((m) => m.name));
      const catalog = await api.mcpCatalog().catch(() => []);
      const missing = catalog.filter((c) => next.mcps?.includes(c.name) && !installed.has(c.name));
      const needKeys: string[] = [];
      for (const entry of missing) {
        if (entry.inputs?.length) needKeys.push(entry.title);
        else await api.addCatalogMcp(entry.name).then(setSettings, () => needKeys.push(entry.title));
      }
      if (needKeys.length) notify(`@${next.name} also uses ${needKeys.join(", ")}: add them in Settings › Tools › MCP catalog.`);
    });
  };

  const intro = editingHost
    ? INTRO.host
    : kind === "agent" && editingAgent
      ? INTRO.editAgent(editingAgent)
      : kind === "skill" && editingSkill
        ? INTRO.editSkill(editingSkill)
        : INTRO[kind];

  const hasDraft = Boolean(hostDraft || agentDraft || skillDraft);
  const hostTools = settings.hostMcps?.length
    ? settings.hostMcps
    : ["all tools", ...(settings.hostSkills?.length ? settings.hostSkills : DEFAULT_HOST_SKILLS).map((s) => `skill:${s}`)];
  const focusForm = hasDraft;

  const toggleList = (list: string[] | undefined, id: string) =>
    (list ?? []).includes(id) ? (list ?? []).filter((x) => x !== id) : [...(list ?? []), id];

  return (
    <section className={`create-ai${focusForm ? " create-ai--editing" : ""}`} aria-label="Agents and skills">
      <div className="create-ai-top">
        <div className="create-ai-kinds" role="tablist" aria-label="What to manage">
          <button type="button" role="tab" aria-selected={kind === "agent"} className={kind === "agent" ? "on" : ""} onClick={() => reset("agent")}>
            Agents
          </button>
          <button type="button" role="tab" aria-selected={kind === "skill"} className={kind === "skill" ? "on" : ""} onClick={() => reset("skill")}>
            Skills
          </button>
        </div>
        {!focusForm && (
          <div className="create-ai-actions">
            <button className="btn" type="button" onClick={startBlank}>
              + New {kind === "agent" ? "agent" : "skill"}
            </button>
            <button className="btn primary" type="button" onClick={startWithAi}>
              + Generate with AI
            </button>
          </div>
        )}
      </div>

      <div className="create-ai-workspace">
      <section className="create-ai-catalog" aria-label={kind === "agent" ? "Agents" : "Skills"}>
        {kind === "skill" && (
          <div className="create-ai-skill-browse">
            <div className="create-ai-skill-search-row">
              <label className="create-ai-skill-search">
                <span className="muted small">Name / topic</span>
                <input
                  className="grow"
                  value={skillSearch}
                  onChange={(e) => setSkillSearch(e.target.value)}
                  placeholder="react, tdd, design…"
                  aria-label="Search skills by name or topic"
                  autoComplete="off"
                />
              </label>
              <label className="create-ai-skill-search">
                <span className="muted small">Owner</span>
                <input
                  className="mono grow"
                  value={skillOwner}
                  onChange={(e) => setSkillOwner(e.target.value)}
                  placeholder="vercel-labs, mattpocock…"
                  aria-label="Filter skills by GitHub owner"
                  autoComplete="off"
                />
              </label>
            </div>
            <div className="chips">
              {SKILL_TOPICS.map((t) => (
                <button
                  key={t}
                  type="button"
                  className={`chip ${skillSearch.trim() === t ? "on" : ""}`}
                  aria-pressed={skillSearch.trim() === t}
                  onClick={() => setSkillSearch(skillSearch.trim() === t ? "" : t)}
                >
                  {t}
                </button>
              ))}
            </div>
            {skillSearching && <p className="muted small create-ai-search-status">Searching…</p>}
            {!skillSearching && skillHits.length > 0 && (
              <p className="muted small create-ai-search-status">
                {skillHits.length} skills on <a href="https://skills.sh" target="_blank" rel="noreferrer">skills.sh</a>, most installed first.
              </p>
            )}
            {!skillSearching &&
              (skillSearch.trim().length >= 2 || skillOwner.trim().length >= 2) &&
              skillHits.length === 0 && (
              <p className="muted small create-ai-search-status">No matches on skills.sh</p>
            )}
            {skillHits.length > 0 && (
              <ul className="create-ai-search-hits" aria-label="skills.sh results">
                {skillHits
                  .map((hit) => ({ hit, have: skills.some((s) => s.name.toLowerCase() === hit.skillId.toLowerCase() || s.name === hit.name) }))
                  .sort((a, b) => Number(b.have) - Number(a.have))
                  .map(({ hit, have }) => {
                  const spec = skillInstallSpec(hit);
                  const busy = installingSpec === spec;
                  return (
                    <li key={spec} className="create-ai-search-hit">
                      <div className="create-ai-search-hit-text">
                        <a className="strong" href={`https://skills.sh/${hit.source}/${hit.skillId}`} target="_blank" rel="noreferrer">
                          {hit.name}
                        </a>
                        <span className="muted small mono">
                          <a href={`https://github.com/${hit.source}`} target="_blank" rel="noreferrer">
                            {hit.source}
                          </a>
                          {hit.installs > 0 ? ` · ${formatInstalls(hit.installs)} installs` : ""}
                        </span>
                      </div>
                      <button
                        type="button"
                        className="btn small primary"
                        disabled={installing || have}
                        onClick={() => installFromSpec(spec)}
                      >
                        {busy ? "Installing…" : have ? "Installed" : "Install"}
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
            <form
              className="row create-ai-install"
              aria-label="Install skill by link"
              onSubmit={(e) => {
                e.preventDefault();
                installFromSpec(skillSource.trim());
              }}
            >
              <input
                className="mono grow"
                value={skillSource}
                onChange={(e) => setSkillSource(e.target.value)}
                placeholder="or paste owner/repo@skill / skills.sh / GitHub link"
                aria-label="Skill source"
              />
              <button className="btn" disabled={!skillSource.trim() || installing}>
                {installing && installingSpec === skillSource.trim() ? "Installing…" : "Install"}
              </button>
            </form>
          </div>
        )}
        {kind === "agent" ? (
          <>
            {!focusForm && STARTERS.length > 0 && (
              <div className="create-ai-starters" aria-label="Starters">
                <h3 className="muted small">Starters</h3>
                <p className="muted small create-ai-starters-hint">
                  {personas.length === 0
                    ? "No agents yet — pick a starter or New with AI."
                    : "One-click agents with a skill pack already wired."}
                </p>
                <div className="create-ai-starter-row">
                  {STARTERS.map((s) => {
                    const have = personas.some((p) => p.name.toLowerCase() === s.name.toLowerCase());
                    return (
                      <button
                        key={s.id}
                        type="button"
                        className="create-ai-starter"
                        disabled={starterBusy === s.id}
                        onClick={() => applyStarter(s.id)}
                      >
                        <span className="create-ai-item-face" aria-hidden="true">
                          <AgentBlob name={s.name} size={32} />
                        </span>
                        <span className="create-ai-starter-text">
                          <span className="strong">@{s.name}</span>
                          <span className="muted small">{s.blurb}</span>
                        </span>
                        <span className="btn small primary">
                          {starterBusy === s.id ? "…" : have ? "Open" : `Add ${s.label}`}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
            <div className={`create-ai-item${editingHost ? " on" : ""}`}>
              <span className="create-ai-item-face" aria-hidden="true">
                <AgentBlob name={BOT_NAME} size={36} animate />
              </span>
              <button type="button" className="create-ai-item-main" onClick={() => startEditHost(false)}>
                <span className="strong">Host (Pi)</span>
                <span className="muted small">{hostTools.join(" · ")}</span>
              </button>
              <span className="create-ai-item-meta">
                <span className="pill accent">locked</span>
                <button className="btn small" type="button" onClick={() => startEditHost(false)}>
                  Edit
                </button>
                <button className="btn small primary" type="button" onClick={() => startEditHost(true)}>
                  Refine with AI
                </button>
              </span>
            </div>
            <div className="create-ai-import">
              <label className="btn small">
                Import agent…
                <input
                  type="file"
                  accept="application/json,.json"
                  multiple
                  hidden
                  onChange={(e) => {
                    if (e.target.files?.length) void importAgents(e.target.files);
                    e.target.value = "";
                  }}
                />
              </label>
            </div>
            {personas.map((p) => (
              <div key={p.name} className={`create-ai-item${editingAgent === p.name ? " on" : ""}`}>
                <span className="create-ai-item-face" aria-hidden="true">
                  <AgentBlob name={p.name} avatar={p.avatar} size={36} />
                </span>
                <button type="button" className="create-ai-item-main" onClick={() => startEditAgent(p, false)}>
                  <span className="strong agent-tint author" style={agentTint(p.name)}>
                    @{p.name}
                  </span>
                  <span className="muted small">{p.prompt ? p.prompt.slice(0, 90) + (p.prompt.length > 90 ? "…" : "") : "No role yet"}</span>
                </button>
                <span className="create-ai-item-meta">
                  <button className="btn small" type="button" onClick={() => startEditAgent(p, false)}>
                    Edit
                  </button>
                  <button className="btn small primary" type="button" onClick={() => startEditAgent(p, true)}>
                    Refine with AI
                  </button>
                  <button className="btn small" type="button" aria-label={`Export @${p.name}`} onClick={() => exportAgent(p)}>
                    Export
                  </button>
                  <button className="btn small danger" type="button" aria-label={`Remove @${p.name}`} onClick={() => removeAgent(p.name)}>
                    Delete
                  </button>
                </span>
              </div>
            ))}
          </>
        ) : skills.length === 0 ? (
          <p className="empty">No skills yet. Create one with AI or manually.</p>
        ) : (
          skills.map((sk) => (
            <div key={sk.name} className={`create-ai-item${editingSkill === sk.name ? " on" : ""}`}>
              <button type="button" className="create-ai-item-main" onClick={() => startEditSkill(sk)}>
                <span className="strong">{sk.name}</span>
                <span className="muted small">
                  {sk.description}
                  {(sk.files?.length ?? 0) > 0 ? ` · ${sk.files!.length} bundled` : ""}
                </span>
              </button>
              <span className="create-ai-item-meta">
                {sk.name === "skill-creator" && <span className="pill accent">Create AI</span>}
                <button className="btn small" type="button" onClick={() => startEditSkill(sk, false)}>
                  Edit
                </button>
                <button className="btn small primary" type="button" onClick={() => startEditSkill(sk, true)}>
                  Refine with AI
                </button>
                {sk.name !== "skill-creator" && (
                  <button className="btn small danger" type="button" aria-label={`Delete skill ${sk.name}`} onClick={() => removeSkill(sk.name)}>
                    Delete
                  </button>
                )}
              </span>
            </div>
            ))
          )}
        {kind === "agent" && templates.length > 0 && !focusForm && (
          <div className="create-ai-templates">
            <h3 className="muted small">Templates</h3>
            {templates.map((t) => (
              <div key={t.id} className="create-ai-item">
                <span className="create-ai-item-main">
                  <span className="strong">{t.id}</span>
                  <span className="muted small">→ @{t.name}</span>
                </span>
                <span className="create-ai-item-meta">
                  <button type="button" className="btn small primary" onClick={() => applyTemplate(t)}>
                    Apply
                  </button>
                  <button
                    type="button"
                    className="btn small"
                    aria-label={`Remove template ${t.id}`}
                    onClick={() =>
                      void save(
                        { templates: templates.filter((x) => x.id !== t.id) },
                        `Template ${t.id} removed`,
                      ).then(() => notify(`Template ${t.id} removed`))
                    }
                  >
                    Delete
                  </button>
                </span>
              </div>
            ))}
          </div>
        )}
        </section>

      {(focusForm || aiOpen) && (
        <div className="create-ai-layout">
          <section className={`create-ai-draft${aiOpen ? " with-ai" : ""}`} aria-label="Editor">
            <div className="create-ai-draft-head">
              <div>
                <h3>
                  {editingHost
                    ? "Host"
                    : editingAgent
                      ? `@${editingAgent}`
                      : editingSkill
                        ? editingSkill
                        : agentDraft
                          ? "New agent"
                          : skillDraft
                            ? "New skill"
                            : "Draft"}
                </h3>
                <p className="muted small create-ai-draft-sub">
                  {editingHost ? "Main agent — cannot be deleted" : ready ? "Ready to save" : "Fill the form or use AI"}
                </p>
              </div>
              {focusForm && (
                <button type="button" className={`btn small${aiOpen ? " primary" : ""}`} onClick={() => setAiOpen((o) => !o)}>
                  {aiOpen ? "Hide AI" : editingSkill || editingAgent || editingHost ? "Refine with AI" : "Generate with AI"}
                </button>
              )}
            </div>

            {editingHost && hostDraft ? (
              <form
                className="persona-form"
                onSubmit={(e) => {
                  e.preventDefault();
                  saveHost();
                }}
              >
                <label className="field">
                  <span>System prompt</span>
                  <CodeEditor
                    value={hostDraft.prompt}
                    onChange={(prompt) => setHostDraft({ ...hostDraft, prompt })}
                    language="markdown"
                    placeholder={HOST_DEFAULT_PROMPT}
                    minHeight={200}
                    ariaLabel="Host system prompt"
                  />
                </label>
                {skillOpts.length > 0 && (
                  <fieldset className="field">
                    <legend>Skills</legend>
                    <ToggleChips
                      options={skillOpts}
                      selected={hostDraft.skills ?? []}
                      onToggle={(id) => setHostDraft({ ...hostDraft, skills: toggleList(hostDraft.skills, id) })}
                    />
                  </fieldset>
                )}
                <fieldset className="field">
                  <legend>Tools</legend>
                  <ToggleChips
                    options={toolOpts}
                    selected={hostDraft.mcps ?? []}
                    onToggle={(id) => setHostDraft({ ...hostDraft, mcps: toggleList(hostDraft.mcps, id) })}
                  />
                  <span className="muted small">None selected = all tools.</span>
                </fieldset>
                <div className="create-ai-actions-bar">
                  <button className="btn primary">Save host</button>
                  <button type="button" className="btn" onClick={() => reset("agent")}>
                    Cancel
                  </button>
                </div>
              </form>
            ) : kind === "agent" && agentDraft ? (
              <form
                className="persona-form"
                onSubmit={(e) => {
                  e.preventDefault();
                  saveAgent();
                }}
              >
                <div className="row create-ai-pair">
                  <label className="field">
                    <span>Name</span>
                    <input
                      className="mono"
                      value={agentDraft.name}
                      onChange={(e) => setAgentDraft({ ...agentDraft, name: e.target.value })}
                      disabled={Boolean(editingAgent)}
                      required
                      autoFocus={!editingAgent}
                    />
                  </label>
                  <span />
                </div>
                <AgentModelField
                  model={agentDraft.model || undefined}
                  effort={agentDraft.effort}
                  defaultModel={settings.models.pi}
                  defaultEffort={settings.effort}
                  onChange={(next) => setAgentDraft({ ...agentDraft, ...next })}
                />
                <div className="row create-ai-pair">
                  <label className="field">
                    <span>Listens</span>
                    <select
                      value={agentDraft.listen ?? "mentions"}
                      onChange={(e) => setAgentDraft({ ...agentDraft, listen: e.target.value === "all" ? "all" : undefined })}
                    >
                      <option value="mentions">Only @mentions</option>
                      <option value="all">Every message</option>
                    </select>
                  </label>
                  <label className="field">
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
                <label className="field">
                  <span>Role</span>
                  <CodeEditor
                    value={agentDraft.prompt}
                    onChange={(prompt) => setAgentDraft({ ...agentDraft, prompt })}
                    language="markdown"
                    minHeight={140}
                    ariaLabel="Agent role"
                  />
                </label>
                <AvatarPicker
                  name={agentDraft.name || editingAgent || "agent"}
                  value={agentDraft.avatar}
                  onChange={(avatar) => setAgentDraft({ ...agentDraft, avatar })}
                />
                <div className="create-ai-form-split">
                  {skillOpts.length > 0 && (
                    <fieldset className="field">
                      <legend>Skills</legend>
                      <ToggleChips
                        options={skillOpts}
                        selected={agentDraft.skills ?? []}
                        onToggle={(id) => setAgentDraft({ ...agentDraft, skills: toggleList(agentDraft.skills, id) })}
                      />
                      <span className="muted small">Packs bring their own tools automatically.</span>
                    </fieldset>
                  )}
                  <fieldset className="field">
                    <legend>Extra tools</legend>
                    <ToggleChips options={toolOpts} selected={agentDraft.mcps ?? []} onToggle={toggleAgentTools} />
                    <span className="muted small">None selected = every tool. Turn on “Ask other agents” to pick who they may ask.</span>
                  </fieldset>
                </div>
                {canAsk && (
                  <fieldset className="field">
                    <legend>Can ask</legend>
                    {peerAgents.length === 0 ? (
                      <p className="muted small">No other agents yet — add peers first.</p>
                    ) : (
                      <ToggleChips
                        options={peerAgents.map((p) => ({ id: p.name, label: `@${p.name}` }))}
                        selected={agentDraft.delegates ?? []}
                        onToggle={(id) => setAgentDraft({ ...agentDraft, delegates: toggleList(agentDraft.delegates, id) })}
                      />
                    )}
                    <span className="muted small">None selected = any other agent.</span>
                  </fieldset>
                )}
                <div className="create-ai-actions-bar">
                  <button className="btn primary" disabled={!agentDraft.name.trim() || !agentDraft.prompt.trim()}>
                    {editingAgent ? "Save changes" : "Save agent"}
                  </button>
                  {editingAgent && (
                    <button type="button" className="btn" onClick={saveAsTemplate} disabled={!agentDraft.name.trim() || !agentDraft.prompt.trim()}>
                      Save as template
                    </button>
                  )}
                  <button type="button" className="btn" onClick={() => reset("agent")}>
                    Cancel
                  </button>
                </div>
              </form>
            ) : kind === "skill" && skillDraft ? (
              <form
                className="persona-form"
                onSubmit={(e) => {
                  e.preventDefault();
                  saveSkill();
                }}
              >
                <div className="row">
                  <label className="field grow">
                    <span>Name</span>
                    <input
                      value={skillDraft.name}
                      onChange={(e) => setSkillDraft({ ...skillDraft, name: e.target.value })}
                      disabled={Boolean(editingSkill)}
                      required
                      autoFocus={!editingSkill}
                    />
                  </label>
                  <label className="field grow">
                    <span>Description</span>
                    <input
                      value={skillDraft.description}
                      onChange={(e) => setSkillDraft({ ...skillDraft, description: e.target.value })}
                    />
                  </label>
                </div>
                <fieldset className="field">
                  <legend>Needs tools</legend>
                  <ToggleChips
                    options={toolOpts}
                    selected={skillDraft.mcps}
                    onToggle={(id) =>
                      setSkillDraft({
                        ...skillDraft,
                        mcps: skillDraft.mcps.includes(id) ? skillDraft.mcps.filter((x) => x !== id) : [...skillDraft.mcps, id],
                      })
                    }
                  />
                  <span className="muted small">
                    Built-in packs (Drive, code…). External MCP apps:{" "}
                    <a href="#settings/tools">Settings → Tools</a>. For your own JS/Python helpers, use Custom tools below.
                  </span>
                </fieldset>
                <label className="field">
                  <span>Instructions (SKILL.md body)</span>
                  <CodeEditor
                    value={skillDraft.body}
                    onChange={(body) => setSkillDraft({ ...skillDraft, body })}
                    language="markdown"
                    path="SKILL.md"
                    minHeight={220}
                    ariaLabel="Skill instructions"
                  />
                  <span className="muted small">Tell the agent when to run your scripts (e.g. “format PDFs with scripts/format-pdf.js”).</span>
                </label>
                <fieldset className="field skill-bundles">
                  <legend>Custom tools (scripts)</legend>
                  <span className="muted small">
                    Your code — JS/Python the agent runs with <code>node</code> / <code>python</code> (needs Code tools). Example: format a PDF.
                  </span>
                  {(skillDraft.files ?? [])
                    .map((f, i) => ({ f, i }))
                    .filter(({ f }) => f.path.startsWith("scripts/"))
                    .map(({ f, i }) => (
                      <div key={`script-${i}`} className="skill-bundle-row">
                        <input
                          className="mono"
                          value={f.path}
                          placeholder="scripts/format-pdf.js"
                          aria-label={`Script path ${i + 1}`}
                          onChange={(e) => {
                            const files = [...(skillDraft.files ?? [])];
                            files[i] = { ...f, path: e.target.value };
                            setSkillDraft({ ...skillDraft, files });
                          }}
                        />
                        <button
                          type="button"
                          className="btn small"
                          aria-label={`Remove ${f.path || "script"}`}
                          onClick={() =>
                            setSkillDraft({
                              ...skillDraft,
                              files: (skillDraft.files ?? []).filter((_, j) => j !== i),
                            })
                          }
                        >
                          Remove
                        </button>
                        <CodeEditor
                          value={f.content}
                          onChange={(content) => {
                            const files = [...(skillDraft.files ?? [])];
                            files[i] = { ...f, content };
                            setSkillDraft({ ...skillDraft, files });
                          }}
                          path={f.path || "scripts/tool.js"}
                          placeholder="// node script…"
                          minHeight={160}
                          ariaLabel={`Script source ${f.path || ""}`}
                        />
                      </div>
                    ))}
                  <div className="row">
                    {(Object.keys(SCRIPT_STUBS) as (keyof typeof SCRIPT_STUBS)[]).map((key) => (
                      <button
                        key={key}
                        type="button"
                        className="btn small"
                        onClick={() => {
                          const stub = SCRIPT_STUBS[key]!;
                          setSkillDraft({
                            ...skillDraft,
                            mcps: ensureCoding(skillDraft.mcps),
                            files: [...(skillDraft.files ?? []), { ...stub }],
                          });
                        }}
                      >
                        + {key === "js" ? "JS tool" : "Python tool"}
                      </button>
                    ))}
                  </div>
                </fieldset>
                <fieldset className="field skill-bundles">
                  <legend>Docs &amp; assets</legend>
                  <span className="muted small">
                    <code>references/</code> (long docs) and <code>assets/</code> (templates) — read on demand, not run.
                  </span>
                  {(skillDraft.files ?? [])
                    .map((f, i) => ({ f, i }))
                    .filter(({ f }) => !f.path.startsWith("scripts/"))
                    .map(({ f, i }) => (
                      <div key={`doc-${i}`} className="skill-bundle-row">
                        <input
                          className="mono"
                          value={f.path}
                          placeholder="references/rules.md"
                          aria-label={`File path ${i + 1}`}
                          onChange={(e) => {
                            const files = [...(skillDraft.files ?? [])];
                            files[i] = { ...f, path: e.target.value };
                            setSkillDraft({ ...skillDraft, files });
                          }}
                        />
                        <button
                          type="button"
                          className="btn small"
                          aria-label={`Remove ${f.path || "file"}`}
                          onClick={() =>
                            setSkillDraft({
                              ...skillDraft,
                              files: (skillDraft.files ?? []).filter((_, j) => j !== i),
                            })
                          }
                        >
                          Remove
                        </button>
                        <CodeEditor
                          value={f.content}
                          onChange={(content) => {
                            const files = [...(skillDraft.files ?? [])];
                            files[i] = { ...f, content };
                            setSkillDraft({ ...skillDraft, files });
                          }}
                          path={f.path || "references/notes.md"}
                          placeholder="File contents…"
                          minHeight={180}
                          ariaLabel={`Content for ${f.path || "file"}`}
                        />
                      </div>
                    ))}
                  <div className="row">
                    <button
                      type="button"
                      className="btn small"
                      onClick={() =>
                        setSkillDraft({
                          ...skillDraft,
                          files: [...(skillDraft.files ?? []), { path: "references/notes.md", content: "" }],
                        })
                      }
                    >
                      + references/
                    </button>
                    <button
                      type="button"
                      className="btn small"
                      onClick={() =>
                        setSkillDraft({
                          ...skillDraft,
                          files: [...(skillDraft.files ?? []), { path: "assets/template.txt", content: "" }],
                        })
                      }
                    >
                      + assets/
                    </button>
                  </div>
                </fieldset>
                <div className="create-ai-actions-bar">
                  <button className="btn primary" disabled={!skillDraft.name.trim() || !skillDraft.body.trim()}>
                    {editingSkill ? "Save changes" : "Save skill"}
                  </button>
                  <button type="button" className="btn" onClick={() => reset("skill")}>
                    Cancel
                  </button>
                </div>
              </form>
            ) : (
              <p className="empty">Pick an agent above, or start a new one.</p>
            )}

            {aiOpen && (
              <div className="create-ai-chat create-ai-chat--dock" aria-label="Refine with AI">
                {(messages.length > 0 || busy) && (
                  <div className="create-ai-thread">
                    {messages.map((m, i) => (
                      <div key={`${m.role}-${i}`} className={`create-ai-msg ${m.role}`}>
                        <span className="create-ai-role">{m.role === "user" ? "You" : "AI"}</span>
                        <p>{m.content}</p>
                      </div>
                    ))}
                    {busy && (
                      <div className="create-ai-msg assistant muted">
                        <p>Thinking…</p>
                      </div>
                    )}
                    <div ref={bottom} />
                  </div>
                )}
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
                    placeholder={intro}
                    disabled={busy}
                    aria-label="Message"
                  />
                  <div className="create-ai-composer-actions">
                    <button className="btn primary" disabled={!input.trim() || busy}>
                      {busy ? "…" : "Send"}
                    </button>
                    {messages.length > 0 && (
                      <button
                        type="button"
                        className="btn"
                        disabled={busy}
                        onClick={() => {
                          setMessages([]);
                          setInput("");
                        }}
                      >
                        Clear
                      </button>
                    )}
                  </div>
                </form>
              </div>
            )}
          </section>
        </div>
      )}
      </div>
    </section>
  );
}
