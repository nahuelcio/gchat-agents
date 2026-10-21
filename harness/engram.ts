import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

type Row = Record<string, string | number | null>;

export function engramPath() {
  const dir = process.env.ENGRAM_DATA_DIR ?? join(homedir(), ".engram");
  return join(dir, "engram.db");
}

const cut = (s: unknown, n: number) => {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
};

export function engramDigest(budget = 60_000, project?: string) {
  const path = engramPath();
  if (!existsSync(path)) return { path, available: false };
  const db = new DatabaseSync(path, { readOnly: true });
  const all = <T = Row>(sql: string) => db.prepare(sql).all() as T[];
  const one = (sql: string) => (db.prepare(sql).get() as { c: number }).c;
  try {
    const projects = all<{ project: string }>("select distinct coalesce(project,'') project from observations where deleted_at is null order by 1").map((p) => p.project);
    const live = project ? `deleted_at is null and coalesce(project,'') = '${project.replace(/'/g, "''")}'` : "deleted_at is null";
    const totals = {
      observations: one(`select count(*) c from observations where ${live}`),
      deleted: one("select count(*) c from observations where deleted_at is not null"),
      pinned: one(`select count(*) c from observations where ${live} and pinned`),
      revised: one(`select count(*) c from observations where ${live} and revision_count > 1`),
      duplicated: one(`select count(*) c from observations where ${live} and duplicate_count > 1`),
      sessions: one("select count(*) c from sessions"),
      sessionsOpen: one("select count(*) c from sessions where ended_at is null"),
      sessionsNoSummary: one("select count(*) c from sessions where summary is null or summary = ''"),
      prompts: one("select count(*) c from user_prompts"),
      last7d: one(`select count(*) c from observations where ${live} and created_at >= datetime('now','-7 days')`),
      last30d: one(`select count(*) c from observations where ${live} and created_at >= datetime('now','-30 days')`),
    };
    const byProject = all(`select coalesce(project,'') project, count(*) n, sum(length(content)) chars, max(created_at) last from observations where ${live} group by 1 order by n desc`);
    const byType = all(`select type, count(*) n, cast(avg(length(content)) as int) avgChars from observations where ${live} group by 1 order by n desc`);
    const byScope = all(`select scope, count(*) n from observations where ${live} group by 1`);
    const bySource = all(`select coalesce(tool_name,'(direct)') source, count(*) n from observations where ${live} group by 1 order by n desc`);
    const relations = all("select relation, judgment_status status, count(*) n from memory_relations group by 1, 2 order by n desc");
    const sameTitle = all(`select title, count(*) n, group_concat(id) ids, group_concat(distinct project) projects from observations where ${live} group by lower(title) having n > 1 order by n desc limit 30`);
    const topics = all(`select topic_key, count(*) n from observations where ${live} and topic_key is not null and topic_key != '' group by 1 having n > 1 order by n desc limit 30`);
    const pendingRelations = all(
      `select r.relation, r.confidence, r.reason, a.id aid, a.title atitle, b.id bid, b.title btitle from memory_relations r
       left join observations a on a.sync_id = r.source_id or cast(a.id as text) = r.source_id
       left join observations b on b.sync_id = r.target_id or cast(b.id as text) = r.target_id
       where r.judgment_status = 'pending' limit 40`,
    ).map((r) => ({ ...r, reason: cut(r.reason, 160) }));
    const sizes = all(`select id, project, type, title, length(content) chars from observations where ${live} order by chars desc limit 10`);
    const prompts = all("select project, created_at, content from user_prompts order by id desc limit 40").map((p) => ({ ...p, content: cut(p.content, 400) }));
    const summaries = all("select project, started_at, summary from sessions where summary is not null and summary != '' order by started_at desc limit 20").map((s) => ({ ...s, summary: cut(s.summary, 500) }));
    const obs = all<{ id: number; project: string; type: string; scope: string; title: string; content: string; topic_key: string; created_at: string; revision_count: number; duplicate_count: number; pinned: number }>(
      `select id, project, type, scope, title, content, topic_key, created_at, revision_count, duplicate_count, pinned from observations where ${live} order by created_at desc`,
    );
    const per = Math.max(80, Math.min(600, Math.floor(budget / Math.max(1, obs.length)) - 120));
    const observations = obs.map((o) => ({
      id: o.id,
      project: o.project,
      type: o.type,
      scope: o.scope === "project" ? undefined : o.scope,
      title: cut(o.title, 140),
      at: o.created_at.slice(0, 10),
      topic: o.topic_key || undefined,
      chars: o.content.length,
      rev: o.revision_count > 1 ? o.revision_count : undefined,
      dup: o.duplicate_count > 1 ? o.duplicate_count : undefined,
      pinned: o.pinned ? true : undefined,
      text: cut(o.content, per),
    }));
    return { path, available: true, projects, project: project ?? null, totals, byProject, byType, byScope, bySource, relations, sameTitle, topics, pendingRelations, sizes, prompts, summaries, observations };
  } finally {
    db.close();
  }
}
