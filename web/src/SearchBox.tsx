import { useEffect, useState } from "react";
import { ago, api, type SearchHit } from "./api";

export function SearchBox() {
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<SearchHit[]>();

  useEffect(() => {
    const query = q.trim();
    if (query.length < 2) return setHits(undefined);
    const id = setTimeout(() => api.search(query).then(setHits, () => setHits([])), 250);
    return () => clearTimeout(id);
  }, [q]);

  const open = (href: string) => {
    location.hash = href;
    setQ("");
  };

  return (
    <div className="search" role="search">
      <input
        type="search"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => e.key === "Escape" && setQ("")}
        placeholder="Search messages"
        aria-label="Search messages"
      />
      {hits && (
        <ul className="search-results" aria-label="Search results">
          {hits.length === 0 && <li className="muted small">No matches.</li>}
          {hits.map((h, i) => (
            <li key={`${h.threadKey}-${i}`}>
              <button type="button" onClick={() => open(h.href)}>
                <span className="strong">{h.title}</span>
                <span className="small">{h.snippet}</span>
                <span className="muted small">{h.author}{h.at ? ` · ${ago(h.at)}` : ""}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
