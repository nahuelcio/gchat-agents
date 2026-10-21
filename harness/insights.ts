import { DatabaseSync } from "node:sqlite";

type Block = { type: string; text?: string; thinking?: string; name?: string; arguments?: unknown };
type Usage = { input?: number; output?: number; cacheRead?: number; reasoning?: number; cost?: { total?: number } };
type Msg = {
  role: string;
  content?: string | Block[];
  sections?: Record<string, string | null>;
  timestamp?: number;
  provider?: string;
  model?: string;
  usage?: Usage;
  stopReason?: string;
  errorMessage?: string;
  toolName?: string;
  isError?: boolean;
  durationMs?: number;
};

type ToolStat = { name: string; calls: number; errors: number; ms: number; argsChars: number; resultChars: number; sampleErrors: string[] };
type ModelStat = { model: string; calls: number; input: number; output: number; cacheRead: number; reasoning: number; cost: number };
type ConvStat = { conversationId: string; thread: string; agent: string; turns: number; toolCalls: number; toolErrors: number; cost: number; input: number; maxInput: number; passes: number };
type Prompt = { chars: number; uses: number; agents: string[]; text: string };
type Exchange = { thread: string; agent: string; at: string; user: string; tools: string[]; reply: string; input: number; cost: number; error?: string };

const text = (c: Msg["content"]) => (typeof c === "string" ? c : (c ?? []).filter((b) => b.type === "text").map((b) => b.text ?? "").join(""));
const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

export type Label = { thread?: string; agent?: string; repos?: string[] };
export type Filter = { agent?: string; repo?: string; thread?: string };

export function insights(dbPath: string, threads: Record<string, string>, labels: Record<string, Label>, days: number, filter: Filter = {}) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  const since = Date.now() - days * 86_400_000;
  const rows = db.prepare("select conversation_id as c, record from entries order by id").all() as { c: number; record: string }[];
  db.close();

  const tools = new Map<string, ToolStat>();
  const models = new Map<string, ModelStat>();
  const convs = new Map<string, ConvStat>();
  const prompts = new Map<string, Prompt>();
  const codemode = { max: 0, last: 0 };
  const exchanges: Exchange[] = [];
  const pending = new Map<string, Exchange>();
  const totals = { turns: 0, cost: 0, input: 0, output: 0, cacheRead: 0, reasoning: 0, passes: 0, passCost: 0, emptyReplies: 0, errors: 0, toolCalls: 0, toolErrors: 0 };
  const errorSamples: string[] = [];
  const options = { agents: new Set<string>(), repos: new Set<string>(), threads: new Set<string>() };

  for (const row of rows) {
    const rec = JSON.parse(row.record) as { kind: string; model?: Msg[] };
    const id = String(row.c);
    const thread = labels[id]?.thread ?? threads[id] ?? "";
    const agent = labels[id]?.agent ?? "deleted thread";
    const repos = labels[id]?.repos?.length ? labels[id].repos! : ["chat-only"];
    if (thread.startsWith("ai-draft/") || agent === "ai-draft") continue;
    options.agents.add(agent);
    for (const r of repos) options.repos.add(r);
    if (thread) options.threads.add(thread);
    if (filter.agent && filter.agent !== agent) continue;
    if (filter.repo && !repos.includes(filter.repo)) continue;
    if (filter.thread && filter.thread !== thread) continue;
    for (const m of rec.model ?? []) {
      if (m.timestamp && m.timestamp < since) continue;
      const conv = convs.get(id) ?? { conversationId: id, thread, agent, turns: 0, toolCalls: 0, toolErrors: 0, cost: 0, input: 0, maxInput: 0, passes: 0 };
      convs.set(id, conv);
      if (m.role === "system") {
        const instr = m.sections?.instructions;
        if (instr) {
          const key = instr.slice(0, 4000);
          const p = prompts.get(key) ?? { chars: instr.length, uses: 0, agents: [], text: instr };
          p.uses++;
          if (!p.agents.includes(agent)) p.agents.push(agent);
          prompts.set(key, p);
        }
        const cm = m.sections?.codemode;
        if (cm) {
          codemode.max = Math.max(codemode.max, cm.length);
          codemode.last = cm.length;
        }
      } else if (m.role === "user") {
        const ex: Exchange = { thread, agent, at: m.timestamp ? new Date(m.timestamp).toISOString() : "", user: cut(text(m.content), 900), tools: [], reply: "", input: 0, cost: 0 };
        pending.set(id, ex);
      } else if (m.role === "assistant") {
        const u = m.usage ?? {};
        const cost = u.cost?.total ?? 0;
        const key = `${m.provider ?? "?"}/${m.model ?? "?"}`;
        const ms = models.get(key) ?? { model: key, calls: 0, input: 0, output: 0, cacheRead: 0, reasoning: 0, cost: 0 };
        ms.calls++;
        ms.input += u.input ?? 0;
        ms.output += u.output ?? 0;
        ms.cacheRead += u.cacheRead ?? 0;
        ms.reasoning += u.reasoning ?? 0;
        ms.cost += cost;
        models.set(key, ms);
        totals.turns++;
        totals.cost += cost;
        totals.input += u.input ?? 0;
        totals.output += u.output ?? 0;
        totals.cacheRead += u.cacheRead ?? 0;
        totals.reasoning += u.reasoning ?? 0;
        conv.turns++;
        conv.cost += cost;
        conv.input += u.input ?? 0;
        conv.maxInput = Math.max(conv.maxInput, u.input ?? 0);
        const reply = text(m.content).trim();
        const calls = typeof m.content === "string" ? [] : (m.content ?? []).filter((b) => b.type === "toolCall");
        if (reply === "PASS") {
          totals.passes++;
          totals.passCost += cost;
          conv.passes++;
        } else if (!reply && calls.length === 0) totals.emptyReplies++;
        if (m.stopReason === "error" || m.errorMessage) {
          totals.errors++;
          if (errorSamples.length < 8) errorSamples.push(cut(m.errorMessage ?? "error", 300));
        }
        for (const c of calls) {
          const t = tools.get(c.name ?? "?") ?? { name: c.name ?? "?", calls: 0, errors: 0, ms: 0, argsChars: 0, resultChars: 0, sampleErrors: [] };
          t.calls++;
          t.argsChars += JSON.stringify(c.arguments ?? {}).length;
          tools.set(t.name, t);
          totals.toolCalls++;
          conv.toolCalls++;
        }
        const ex = pending.get(id);
        if (ex) {
          ex.tools.push(...calls.map((c) => c.name ?? "?"));
          ex.input = Math.max(ex.input, u.input ?? 0);
          ex.cost += cost;
          if (reply) ex.reply = cut(reply, 700);
          if (m.errorMessage) ex.error = cut(m.errorMessage, 200);
          if (calls.length === 0) {
            exchanges.push(ex);
            pending.delete(id);
          }
        }
      } else if (m.role === "toolResult") {
        const t = tools.get(m.toolName ?? "?") ?? { name: m.toolName ?? "?", calls: 0, errors: 0, ms: 0, argsChars: 0, resultChars: 0, sampleErrors: [] };
        const out = text(m.content);
        t.resultChars += out.length;
        t.ms += m.durationMs ?? 0;
        if (m.isError) {
          t.errors++;
          totals.toolErrors++;
          conv.toolErrors++;
          if (t.sampleErrors.length < 3) t.sampleErrors.push(cut(out, 300));
        }
        tools.set(t.name, t);
      }
    }
  }

  const promptList = [...prompts.values()].sort((a, b) => b.uses - a.uses);
  return {
    days,
    totals,
    models: [...models.values()].sort((a, b) => b.cost - a.cost),
    tools: [...tools.values()].sort((a, b) => b.calls - a.calls),
    conversations: [...convs.values()].filter((c) => c.turns > 0).sort((a, b) => b.cost - a.cost).slice(0, 15),
    prompts: promptList.slice(0, 8).map((p) => ({ chars: p.chars, uses: p.uses, agents: p.agents.slice(0, 8), text: cut(p.text, 6000) })),
    agents: [...[...convs.values()].reduce((m, c) => {
      const a = m.get(c.agent) ?? { agent: c.agent, conversations: 0, turns: 0, toolCalls: 0, toolErrors: 0, cost: 0, input: 0, passes: 0 };
      a.conversations++;
      a.turns += c.turns;
      a.toolCalls += c.toolCalls;
      a.toolErrors += c.toolErrors;
      a.cost += c.cost;
      a.input += c.input;
      a.passes += c.passes;
      return m.set(c.agent, a);
    }, new Map<string, { agent: string; conversations: number; turns: number; toolCalls: number; toolErrors: number; cost: number; input: number; passes: number }>()).values()].filter((a) => a.turns > 0).sort((a, b) => b.cost - a.cost),
    codemodeChars: codemode,
    errorSamples,
    exchanges: exchanges.filter((e) => e.reply !== "PASS").slice(-80).reverse(),
    options: { agents: [...options.agents].sort(), repos: [...options.repos].sort(), threads: [...options.threads].sort() },
  };
}
