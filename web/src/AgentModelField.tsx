import { useEffect, useMemo, useState } from "react";
import { api } from "./api";

const providerOf = (model: string) => model.slice(0, Math.max(0, model.indexOf("/"))) || model;

const EFFORTS = [
  { value: "", label: "Default" },
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "max", label: "Max" },
];

export function AgentModelField({
  model,
  effort,
  defaultModel,
  defaultEffort,
  onChange,
}: {
  model?: string;
  effort?: string;
  defaultModel?: string;
  defaultEffort?: string;
  onChange: (next: { model?: string; effort?: string }) => void;
}) {
  const [models, setModels] = useState<string[]>([]);
  const [provider, setProvider] = useState(model ? providerOf(model) : "");
  useEffect(() => {
    api.models(false).then(setModels, () => setModels([]));
  }, []);
  const providers = useMemo(() => [...new Set(models.map(providerOf))].sort(), [models]);
  const options = useMemo(() => models.filter((m) => providerOf(m) === provider), [models, provider]);
  const known = !model || models.length === 0 || models.includes(model);

  return (
    <div className="agent-model">
      <div className="row create-ai-pair">
        <label className="field">
          <span>Provider</span>
          <select
            value={provider}
            onChange={(e) => {
              setProvider(e.target.value);
              onChange({ model: undefined, effort });
            }}
          >
            <option value="">Same as default{defaultModel ? ` (${providerOf(defaultModel)})` : ""}</option>
            {providers.map((p) => (
              <option key={p} value={p}>{p}</option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Model</span>
          <select
            className="mono"
            value={model ?? ""}
            disabled={!provider}
            onChange={(e) => onChange({ model: e.target.value || undefined, effort })}
          >
            <option value="">{provider ? "Pick a model" : defaultModel ?? "Default model"}</option>
            {!known && model && <option value={model}>{model}</option>}
            {options.map((m) => (
              <option key={m} value={m}>{m.slice(provider.length + 1)}</option>
            ))}
          </select>
        </label>
      </div>
      <div className="field">
        <span>Effort</span>
        <div className="chips" role="radiogroup" aria-label="Effort">
          {EFFORTS.map((e) => (
            <button
              key={e.value}
              type="button"
              role="radio"
              aria-checked={(effort ?? "") === e.value}
              className={`chip${(effort ?? "") === e.value ? " on" : ""}`}
              onClick={() => onChange({ model, effort: e.value || undefined })}
            >
              {e.value ? e.label : `Default (${defaultEffort ?? "high"})`}
            </button>
          ))}
        </div>
        <span className="muted small">More effort thinks longer: better on hard tasks, slower and pricier.</span>
      </div>
    </div>
  );
}
