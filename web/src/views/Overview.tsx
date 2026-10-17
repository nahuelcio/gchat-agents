import { useEffect, useState } from "react";
import { ago, api, until, type ActivityEvent, type Job, type Thread } from "../api";
import type { ViewProps } from "../App";

const ACTIVITY_FILTERS = {
  All: () => true,
  Failures: (e: ActivityEvent) => e.kind.endsWith("_fail"),
  Schedules: (e: ActivityEvent) => e.kind.startsWith("schedule_") || e.kind.startsWith("approval_"),
  Rooms: (e: ActivityEvent) => e.kind.startsWith("member_") || e.kind.startsWith("turn_") || e.kind === "repo_attach",
};

export function Overview({ notify }: ViewProps) {
  const [threads, setThreads] = useState<Thread[]>();
  const [jobs, setJobs] = useState<Job[]>([]);
  const [activity, setActivity] = useState<ActivityEvent[]>();
  const [filter, setFilter] = useState<keyof typeof ACTIVITY_FILTERS>("All");
  const [logs, setLogs] = useState<{ slug: string; text: string }>();
  const [endpoint, setEndpoint] = useState<string>();
  const [chatConnected, setChatConnected] = useState(true);

  useEffect(() => {
    api.health().then((h) => setEndpoint(h.endpoint), () => {});
    api.google().then((g) => setChatConnected(g.configured), () => {});
  }, []);

  useEffect(() => {
    const load = () => {
      api.threads().then(setThreads, () => {});
      api.schedules().then(setJobs, () => {});
      api.activity().then(setActivity, () => {});
    };
    load();
    const id = setInterval(load, 3000);
    return () => clearInterval(id);
  }, []);

  // Google Chat threads only: team chat and schedules have their own views.
  const real = threads?.filter((t) => t.key.startsWith("spaces/")) ?? [];
  const chats = threads?.filter((t) => !t.key.startsWith("schedule/")) ?? [];
  const team = chats.length - real.length;
  const running = chats.filter((t) => t.app.running).length;
  const next = jobs.filter((j) => j.enabled && j.nextRunAt).sort((a, b) => a.nextRunAt!.localeCompare(b.nextRunAt!))[0];

  return (
    <>
      <header className="page-head">
        <div>
          <h1>Overview</h1>
          <p className="sub">Threads this machine is working on, live.</p>
        </div>
        <a className="btn primary" href="#team">
          Open team chat
        </a>
      </header>

      {!chatConnected && (
        <a className="banner" href="#settings">
          <span>
            <span className="strong">Google Chat is not connected.</span> The team chat works; to answer in Google Chat, follow the 4-step setup.
          </span>
          <span className="btn primary">Set up</span>
        </a>
      )}

      {endpoint && chatConnected && (
        <section className="card endpoint">
          <div className="card-title">
            <h2>Google Chat endpoint</h2>
            <p className="muted small">Paste it as the Chat app's HTTP endpoint URL. It stays the same across restarts.</p>
          </div>
          <div className="row">
            <code className="grow endpoint-url">{endpoint}</code>
            <button
              className="btn"
              onClick={() => navigator.clipboard.writeText(endpoint).then(() => notify("Endpoint copied"), () => notify("Copy failed — select it manually", true))}
            >
              Copy
            </button>
          </div>
        </section>
      )}

      <div className="stats">
        <div className="stat">
          <span>Active threads</span>
          <strong>{threads ? chats.length : "–"}</strong>
          {threads && <small className="muted">{real.length} in Google Chat · {team} in team chat</small>}
        </div>
        <div className="stat">
          <span>Apps running</span>
          <strong className={running ? "accent" : ""}>{threads ? running : "–"}</strong>
        </div>
        <div className="stat">
          <span>Next scheduled run</span>
          <strong className="small">{next ? until(next.nextRunAt) : "None"}</strong>
          {next && <small>{next.name}</small>}
        </div>
      </div>

      <section className="card flush" aria-label="Activity">
        <div className="card-head">
          <h2>Activity</h2>
          <fieldset className="chips">
            <legend className="sr-only">Filter activity</legend>
            {(Object.keys(ACTIVITY_FILTERS) as (keyof typeof ACTIVITY_FILTERS)[]).map((f) => (
              <label key={f} className={`chip ${filter === f ? "on" : ""}`}>
                <input type="radio" name="activity" checked={filter === f} onChange={() => setFilter(f)} />
                {f}
              </label>
            ))}
          </fieldset>
        </div>
        {activity && activity.filter(ACTIVITY_FILTERS[filter]).length === 0 && <p className="empty">Nothing yet. Open the team chat or wait for a schedule.</p>}
        <ul className="activity">
          {activity?.filter(ACTIVITY_FILTERS[filter]).map((e) => (
            <li key={e.id} className={`activity-row ${e.kind.endsWith("_fail") ? "bad" : ""}`}>
              <span className="muted small activity-when">{ago(e.at)}</span>
              <span className="badge">{e.kind.replace("_", " ")}</span>
              <a href={e.href} className="activity-title">{e.title || e.kind}</a>
              {e.detail && <span className="muted small activity-detail">{e.detail}</span>}
            </li>
          ))}
        </ul>
      </section>

      <section className="card flush">
        <div className="card-head">
          <h2>Threads</h2>
          <span className="muted">Refreshes every 3 s</span>
        </div>
        {threads && real.length === 0 && <p className="empty">No Google Chat threads yet. Mention the bot in the team space, or use the team chat.</p>}
        {real.length > 0 && (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Thread</th>
                  <th>In the room</th>
                  <th>Repo and branch</th>
                  <th>App</th>
                  <th>Last activity</th>
                  <th>
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {real.map((t) => (
                  <tr key={t.key}>
                    <td>
                      <div className="strong">{t.slug}</div>
                      {t.context && <div className="mono muted">{t.context}</div>}
                    </td>
                    <td>
                      {t.members?.length ? (
                        <div className="room-chips">
                          {t.members.map((m) => (
                            <span key={m} className="chip">{m}</span>
                          ))}
                        </div>
                      ) : (
                        <span className="muted">—</span>
                      )}
                    </td>
                    <td>
                      {t.repo ? (
                        <>
                          <div>{t.repo}</div>
                          <div className="mono muted">{t.branch}</div>
                        </>
                      ) : (
                        <span className="muted">Chat only</span>
                      )}
                    </td>
                    <td>
                      {t.app.running ? (
                        <a className="pill ok" href={`http://localhost:${t.app.port}`} target="_blank" rel="noreferrer">
                          <span className="dot" aria-hidden="true" />
                          localhost:{t.app.port}
                        </a>
                      ) : (
                        <span className="pill">Stopped</span>
                      )}
                    </td>
                    <td className="muted">{ago(t.updatedAt)}</td>
                    <td>
                      <div className="row-actions">
                        {t.repo && (
                          <button className="btn" onClick={() => api.logs(t.slug).then((r) => setLogs({ slug: t.slug, text: r.logs || "No output yet." }))}>
                            Logs
                          </button>
                        )}
                        {t.app.running && (
                          <button className="btn danger" onClick={() => api.stop(t.slug).then(() => notify("App stopped"))}>
                            Stop
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {logs && (
        <section className="card">
          <div className="card-head">
            <h2>Logs · {logs.slug}</h2>
            <button className="btn" onClick={() => setLogs(undefined)}>
              Close
            </button>
          </div>
          <pre className="logs">{logs.text}</pre>
        </section>
      )}
    </>
  );
}
