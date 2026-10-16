import { useEffect, useState } from "react";
import { ago, api, until, type Job, type Thread } from "../api";
import type { ViewProps } from "../App";

export function Overview({ notify }: ViewProps) {
  const [threads, setThreads] = useState<Thread[]>();
  const [jobs, setJobs] = useState<Job[]>([]);
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
    };
    load();
    const id = setInterval(load, 3000);
    return () => clearInterval(id);
  }, []);

  const real = threads?.filter((t) => !t.key.startsWith("playground/") && !t.key.startsWith("schedule/")) ?? [];
  const running = real.filter((t) => t.app.running).length;
  const next = jobs.filter((j) => j.enabled && j.nextRunAt).sort((a, b) => a.nextRunAt!.localeCompare(b.nextRunAt!))[0];

  return (
    <>
      <header className="page-head">
        <div>
          <h1>Overview</h1>
          <p className="sub">Threads this machine is working on, live.</p>
        </div>
        <a className="btn primary" href="#playground">
          Test in playground
        </a>
      </header>

      {!chatConnected && (
        <a className="banner" href="#settings">
          <span>
            <span className="strong">Google Chat is not connected.</span> The playground works; to answer in Chat, follow the 4-step setup.
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
          <strong>{threads ? real.length : "–"}</strong>
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

      <section className="card flush">
        <div className="card-head">
          <h2>Threads</h2>
          <span className="muted">Refreshes every 3 s</span>
        </div>
        {threads && real.length === 0 && <p className="empty">No threads yet. Mention the bot in the team space, or try the playground.</p>}
        {real.length > 0 && (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Thread</th>
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
