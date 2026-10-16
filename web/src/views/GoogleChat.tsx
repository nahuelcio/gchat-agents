import { useEffect, useState, type ReactNode } from "react";
import { api, type GoogleStatus } from "../api";
import type { ViewProps } from "../App";

const LINKS = {
  chatApi: "https://console.cloud.google.com/apis/library/chat.googleapis.com",
  serviceAccounts: "https://console.cloud.google.com/iam-admin/serviceaccounts",
  chatConfig: "https://console.cloud.google.com/apis/api/chat.googleapis.com/hangouts-chat",
};

function Step({ n, title, state, children }: { n: number; title: string; state: "done" | "todo" | "manual"; children: ReactNode }) {
  const label = state === "done" ? "Done" : state === "manual" ? "In Google Cloud" : "To do";
  return (
    <li className={`step ${state}`}>
      <span className="step-n" aria-hidden="true">
        {state === "done" ? (
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
            <path d="M5 12l5 5 9-10" />
          </svg>
        ) : (
          n
        )}
      </span>
      <div className="step-body">
        <div className="step-title">
          <span className="strong">{title}</span>
          <span className={`pill ${state === "done" ? "ok" : ""}`}>{label}</span>
        </div>
        {children}
      </div>
    </li>
  );
}

function Ext({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noreferrer">
      {children}
    </a>
  );
}

/** Google Chat setup as a 4-step guide; steps that live in Google Cloud are confirmed by the final test. */
export function GoogleChatCard({ settings, save, notify }: ViewProps) {
  const [status, setStatus] = useState<GoogleStatus>();
  const [key, setKey] = useState("");
  const [space, setSpace] = useState(settings.allowedSpaces[0] ?? "");
  const [tested, setTested] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.google().then(setStatus, () => setStatus({ configured: false, source: "none" }));
  }, []);

  async function run(fn: () => Promise<GoogleStatus>, ok: string): Promise<boolean> {
    setBusy(true);
    try {
      setStatus(await fn());
      notify(ok);
      return true;
    } catch (err) {
      notify(err instanceof Error ? err.message : String(err), true);
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function sendTest() {
    const value = space.trim().startsWith("spaces/") ? space.trim() : `spaces/${space.trim()}`;
    if (!settings.allowedSpaces.includes(value)) await save({ allowedSpaces: [...settings.allowedSpaces, value] }, `${value} allowed`);
    setTested(await run(() => api.googleTest(value), `Test message sent to ${value}`));
  }

  const connected = Boolean(status?.configured);
  const done = connected && tested;

  return (
    <section className="card" aria-labelledby="gchat-title">
      <div className="card-head">
        <div className="card-title">
          <h2 id="gchat-title">Google Chat</h2>
          <p className="muted small">
            {done
              ? "Connected and tested. Mention the bot in a thread to start."
              : connected
                ? `Key loaded for ${status?.clientEmail ?? "the service account"}. Finish the steps and send a test.`
                : "Four steps, about 10 minutes, once per machine."}
          </p>
        </div>
        <span className={`pill ${done ? "ok" : connected ? "accent" : ""}`}>{done ? "Connected" : connected ? "Key loaded" : "Not connected"}</span>
      </div>

      <ol className="steps">
        <Step n={1} title="Enable the Google Chat API" state={done ? "done" : "manual"}>
          <p>
            In your Google Cloud project, open <Ext href={LINKS.chatApi}>Google Chat API</Ext> and click <b>Enable</b>. No project yet? Create one from the same page.
          </p>
        </Step>

        <Step n={2} title="Create a service account key" state={connected ? "done" : "todo"}>
          <p>
            In <Ext href={LINKS.serviceAccounts}>Service accounts</Ext>: <b>Create service account</b> (no roles needed) → open it → <b>Keys</b> → <b>Add key</b> → <b>JSON</b>. A file downloads; load it here. It is stored on this machine only (data/google-sa.json, readable by you) and never shown again.
          </p>
          {status?.source === "env" ? (
            <p className="muted small">Using GOOGLE_SERVICE_ACCOUNT_JSON from the environment ({status.clientEmail}). Remove it there to manage the key here.</p>
          ) : connected ? (
            <div className="row">
              <code className="grow">{status?.clientEmail}</code>
              <button className="btn" disabled={busy} onClick={() => void run(api.googleClear, "Key removed")}>
                Replace key
              </button>
            </div>
          ) : (
            <div className="key-input">
              <label className="btn file">
                Choose JSON file
                <input
                  type="file"
                  accept="application/json,.json"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) void file.text().then((text) => run(() => api.googleKey(text), "Key saved"));
                    e.target.value = "";
                  }}
                />
              </label>
              <span className="muted small">or paste it</span>
              <textarea className="mono" rows={3} value={key} onChange={(e) => setKey(e.target.value)} placeholder='{"type": "service_account", ...}' aria-label="Service account key JSON" />
              <button className="btn primary" disabled={!key.trim() || busy} onClick={() => void run(() => api.googleKey(key), "Key saved").then((ok) => ok && setKey(""))}>
                Save key
              </button>
            </div>
          )}
        </Step>

        <Step n={3} title="Configure the Chat app" state={done ? "done" : "manual"}>
          <p>
            Open <Ext href={LINKS.chatConfig}>Chat API › Configuration</Ext> and fill in:
          </p>
          <dl className="fields">
            <dt>App name, avatar, description</dt>
            <dd>Whatever the team will see, e.g. “Nahuel's agent”.</dd>
            <dt>Functionality</dt>
            <dd>Join spaces and group conversations.</dd>
            <dt>Connection settings</dt>
            <dd>
              <b>HTTP endpoint URL</b>:{" "}
              {status?.endpoint ? (
                <span className="copy">
                  <code>{status.endpoint}</code>
                  <button className="btn small" onClick={() => navigator.clipboard.writeText(status.endpoint!).then(() => notify("Endpoint copied"), () => notify("Copy failed — select it manually", true))}>
                    Copy
                  </button>
                </span>
              ) : (
                <span className="warn-text">no public URL — start with the tunnel on (default)</span>
              )}
            </dd>
            <dt>Authentication audience</dt>
            <dd>
              <b>HTTP endpoint URL</b> (the same URL as above).
            </dd>
            <dt>Visibility</dt>
            <dd>The people or groups of your domain who should use it.</dd>
          </dl>
        </Step>

        <Step n={4} title="Add the bot to a space and test" state={tested ? "done" : "todo"}>
          <p>
            In Google Chat, open the team space → space name → <b>Apps &amp; integrations</b> → <b>Add apps</b> → your app. The space id is in its URL: <code>chat.google.com/room/XXXX</code> → <code>spaces/XXXX</code>.
          </p>
          <form
            className="row"
            onSubmit={(e) => {
              e.preventDefault();
              void sendTest();
            }}
          >
            <label className="sr-only" htmlFor="test-space">
              Space to test
            </label>
            <input id="test-space" className="mono grow" value={space} onChange={(e) => setSpace(e.target.value)} placeholder="spaces/XXXX" required />
            <button className="btn primary" disabled={!connected || busy}>
              {busy ? "Sending…" : "Allow and send test"}
            </button>
          </form>
          {!connected && <p className="muted small">Load the key in step 2 first.</p>}
        </Step>
      </ol>
    </section>
  );
}
