import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { api } from "./api";

export type ArtifactRef = { id: string; title: string; src: string };

type Ctx = {
  active: ArtifactRef | null;
  open: (a: ArtifactRef) => void;
  close: () => void;
};

const ArtifactPreviewContext = createContext<Ctx | null>(null);

export function ArtifactPreviewProvider({ children }: { children: ReactNode }) {
  const [active, setActive] = useState<ArtifactRef | null>(null);
  const open = useCallback((a: ArtifactRef) => setActive(a), []);
  const close = useCallback(() => setActive(null), []);
  const value = useMemo(() => ({ active, open, close }), [active, open, close]);
  return <ArtifactPreviewContext.Provider value={value}>{children}</ArtifactPreviewContext.Provider>;
}

export function useArtifactPreview(): Ctx {
  const ctx = useContext(ArtifactPreviewContext);
  if (!ctx) throw new Error("useArtifactPreview outside provider");
  return ctx;
}

export function useArtifactPreviewOptional(): Ctx | null {
  return useContext(ArtifactPreviewContext);
}

export function ArtifactCard({ title, src, id }: { title: string; src: string; id: string }) {
  const preview = useArtifactPreviewOptional();
  const selected = preview?.active?.id === id;

  function activate() {
    if (!preview) {
      window.open(src, "_blank", "noopener");
      return;
    }
    if (selected) preview.close();
    else preview.open({ id, title, src });
  }

  return (
    <button type="button" className={`artifact-chip${selected ? " on" : ""}`} onClick={activate}>
      <span className="artifact-chip-icon" aria-hidden="true">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          <rect x="3" y="4" width="18" height="16" rx="2" />
          <path d="M3 9h18" />
        </svg>
      </span>
      <span className="artifact-chip-body">
        <span className="artifact-chip-label">Artifact</span>
        <strong className="artifact-chip-title">{title}</strong>
      </span>
      <span className="artifact-chip-hint">{selected ? "Hide" : "View"}</span>
    </button>
  );
}

export function ArtifactPane() {
  const { active, close } = useArtifactPreview();
  const [copied, setCopied] = useState(false);
  if (!active) return null;

  async function copyLink() {
    try {
      let href = new URL(active!.src, location.origin).href;
      try {
        const { link } = await api.share();
        const pub = new URL(link);
        const token = pub.hash.replace(/^#/, "").split("&")[0];
        if (token) {
          href = `${pub.origin}/play/api/media/${active!.id}?access=${encodeURIComponent(token)}`;
        } else {
          href = new URL(active!.src, pub.origin).href;
        }
      } catch {
        // no tunnel — keep local origin
      }
      await navigator.clipboard.writeText(href);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard blocked
    }
  }

  return (
    <aside className="artifact-pane" aria-label={`Artifact: ${active.title}`}>
      <header className="artifact-pane-bar">
        <span className="artifact-pane-eye" aria-hidden="true">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z" />
            <circle cx="12" cy="12" r="3" />
          </svg>
        </span>
        <div className="artifact-pane-titles">
          <span className="artifact-pane-kicker">Artifact</span>
          <strong className="artifact-pane-title">{active.title}</strong>
        </div>
        <div className="artifact-pane-actions">
          <button type="button" className="btn small" onClick={() => void copyLink()}>
            {copied ? "Copied" : "Copy link"}
          </button>
          <a className="btn small" href={active.src} download={`${slug(active.title)}.html`}>
            Download
          </a>
          <a className="btn small" href={active.src} target="_blank" rel="noopener noreferrer">
            Open
          </a>
          <button type="button" className="btn icon ghost" aria-label="Close artifact" title="Close" onClick={close}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </div>
      </header>
      <div className="artifact-pane-stage">
        <iframe
          className="artifact-pane-frame"
          title={active.title}
          src={active.src}
          sandbox="allow-scripts allow-forms allow-modals allow-popups"
          referrerPolicy="no-referrer"
        />
      </div>
    </aside>
  );
}

function slug(title: string): string {
  return (
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 48) || "artifact"
  );
}
