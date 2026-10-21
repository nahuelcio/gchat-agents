import { useEffect, useMemo, useState } from "react";
import { api } from "./api";

const providerOf = (model: string) => model.slice(0, Math.max(0, model.indexOf("/"))) || model;

export function ModelPicker({ value, onPick }: { value?: string; onPick: (model: string) => void }) {
  const [models, setModels] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [provider, setProvider] = useState(value ? providerOf(value) : "");
  const [filter, setFilter] = useState("");

  const load = (refresh = false) => {
    setBusy(true);
    return api.models(refresh).then(setModels, () => setModels([])).finally(() => setBusy(false));
  };
  useEffect(() => {
    void load();
  }, []);

  const providers = useMemo(() => [...new Set(models.map(providerOf))].sort(), [models]);
  const shown = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    return models.filter((m) => (!provider || providerOf(m) === provider) && (!needle || m.toLowerCase().includes(needle)));
  }, [models, provider, filter]);

  return (
    <div className="model-picker">
      <div className="row">
        <select value={provider} onChange={(e) => setProvider(e.target.value)} aria-label="Provider">
          <option value="">All providers</option>
          {providers.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
        <input className="mono grow" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter models" aria-label="Filter models" />
        <button type="button" className="btn linkish" disabled={busy} onClick={() => void load(true)}>
          {busy ? "Loading…" : "Refresh"}
        </button>
      </div>
      {shown.length > 0 && <select
        className="mono"
        size={Math.min(8, Math.max(2, shown.length))}
        value={value ?? ""}
        onChange={(e) => e.target.value && onPick(e.target.value)}
        aria-label="Model"
      >
        {shown.map((m) => (
          <option key={m} value={m}>
            {provider ? m.slice(provider.length + 1) : m}
          </option>
        ))}
      </select>}
      {!busy && shown.length === 0 && (
        <span className="muted small">{models.length > 0 ? "No models match this filter." : "No models listed yet. Press Refresh."}</span>
      )}
    </div>
  );
}
