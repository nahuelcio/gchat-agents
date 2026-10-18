import { useState } from "react";

export function ArtifactCard({ title, src }: { title: string; src: string }) {
  const [open, setOpen] = useState(true);

  return (
    <div className="artifact">
      <div className="artifact-bar">
        <span className="artifact-label">Artifact</span>
        <strong className="artifact-title">{title}</strong>
        <span className="artifact-actions">
          <button type="button" className="btn small" onClick={() => setOpen((v) => !v)}>
            {open ? "Collapse" : "Expand"}
          </button>
          <a className="btn small" href={src} target="_blank" rel="noopener noreferrer">
            Open
          </a>
        </span>
      </div>
      {open && (
        <iframe
          className="artifact-frame"
          title={title}
          src={src}
          sandbox="allow-scripts allow-forms allow-modals allow-popups"
          referrerPolicy="no-referrer"
        />
      )}
    </div>
  );
}
