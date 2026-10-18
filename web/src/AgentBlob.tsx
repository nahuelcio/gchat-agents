import { useEffect, useState } from "react";
import { agentHue, BOT_NAME } from "./agent-color";

/** Customizable blob face for agents (inspired by bloub-style morph avatars). */
export type BlobShape = "round" | "soft" | "tall" | "bean";
export type BlobExpression = "idle" | "wink" | "happy" | "sleepy" | "curious";

export interface PersonaAvatar {
  color: string;
  shape: BlobShape;
  expression: BlobExpression;
}

export const HOST_BLOB_COLOR = "#111111";

export const BLOB_COLORS = [
  "#0f766e",
  "#0369a1",
  "#4f46e5",
  "#7c3aed",
  "#be185d",
  "#c2410c",
  "#b45309",
  "#15803d",
  "#0891b2",
  "#e11d48",
  "#ca8a04",
  "#db2777",
] as const;

function isHostName(name: string): boolean {
  const bare = name.replace(/^@/, "").toLowerCase();
  return bare === BOT_NAME.toLowerCase() || bare === "host" || bare === "switchboard";
}

function isHostBlack(color: string): boolean {
  const c = color.trim().toLowerCase();
  return c === HOST_BLOB_COLOR || c === "#000" || c === "#000000" || c === "#1a1a2e" || c === "#374151";
}

export const BLOB_SHAPES: { id: BlobShape; label: string }[] = [
  { id: "round", label: "Round" },
  { id: "soft", label: "Soft" },
  { id: "tall", label: "Tall" },
  { id: "bean", label: "Bean" },
];

export const BLOB_EXPRESSIONS: { id: BlobExpression; label: string }[] = [
  { id: "idle", label: "Idle" },
  { id: "wink", label: "Wink" },
  { id: "happy", label: "Happy" },
  { id: "sleepy", label: "Sleepy" },
  { id: "curious", label: "Curious" },
];

const BODY: Record<BlobShape, string> = {
  round: "M16 3.2C23.1 3.2 28.8 8.9 28.8 16S23.1 28.8 16 28.8 3.2 23.1 3.2 16 8.9 3.2 16 3.2Z",
  soft: "M16 2.8C22.8 2.8 28.5 7.6 29.2 14.2c.5 4.8-1.6 9.4-5.4 12.1-3.2 2.3-7.4 3.1-11.2 1.9C7.2 26.5 3.5 21.8 3.1 16.2 2.6 9.4 8.2 2.8 16 2.8Z",
  tall: "M16 2.4C22.4 2.4 27.6 7.8 27.6 15.2c0 6.2-3.4 11.6-8.4 13.6-1.4.6-3 .9-4.6.9-7.2 0-13-6.2-13-13.8C1.6 8 7.4 2.4 16 2.4Z",
  bean: "M17.2 3C24.2 3.4 29.2 9.2 28.6 16.2c-.5 6.2-5.4 11.2-11.6 11.6C10.2 28.2 4.2 23.6 3.4 17.2 2.4 10 8.2 3.6 17.2 3Z",
};

type EyeSpec = { cx: number; cy: number; rx: number; ry: number; rot: number };

function eyesFor(expression: BlobExpression, blink: boolean): [EyeSpec, EyeSpec] {
  const lean = -26;
  const baseL: EyeSpec = { cx: 12.2, cy: 14.2, rx: 2.35, ry: 4.5, rot: lean };
  const baseR: EyeSpec = { cx: 19.8, cy: 14.2, rx: 2.35, ry: 4.5, rot: lean };
  if (blink) {
    return [
      { ...baseL, ry: 0.5 },
      { ...baseR, ry: 0.5 },
    ];
  }
  switch (expression) {
    case "wink":
      return [baseL, { ...baseR, ry: 0.5 }];
    case "happy":
      return [
        { ...baseL, cy: 14.6, ry: 3.2 },
        { ...baseR, cy: 14.6, ry: 3.2 },
      ];
    case "sleepy":
      return [
        { ...baseL, ry: 2, cy: 15 },
        { ...baseR, ry: 2, cy: 15 },
      ];
    case "curious":
      return [
        { ...baseL, cx: 11.6, cy: 13.5, rx: 2.5, ry: 5 },
        { ...baseR, cx: 20.4, cy: 13.5, rx: 2.1, ry: 4 },
      ];
    default:
      return [baseL, baseR];
  }
}

function hashName(name: string): number {
  let h = 0;
  for (const ch of name.replace(/^@/, "").toLowerCase()) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h;
}

/** Stable default avatar from agent name when none is saved. */
export function avatarFromName(name: string): PersonaAvatar {
  if (isHostName(name)) {
    return { color: HOST_BLOB_COLOR, shape: "round", expression: "idle" };
  }
  const h = hashName(name);
  return {
    color: BLOB_COLORS[h % BLOB_COLORS.length]!,
    shape: BLOB_SHAPES[h % BLOB_SHAPES.length]!.id,
    expression: "idle",
  };
}

export function resolveAvatar(name: string, avatar?: PersonaAvatar | null): PersonaAvatar {
  const fallback = avatarFromName(name);
  if (isHostName(name)) {
    return {
      color: HOST_BLOB_COLOR,
      shape: avatar?.shape ?? fallback.shape,
      expression: avatar?.expression ?? fallback.expression,
    };
  }
  let color = avatar?.color ?? fallback.color;
  if (isHostBlack(color)) color = fallback.color;
  return {
    color,
    shape: avatar?.shape ?? fallback.shape,
    expression: avatar?.expression ?? fallback.expression,
  };
}

export function AgentBlob({
  name,
  avatar,
  size = 34,
  animate = false,
  busy = false,
  className,
}: {
  name: string;
  avatar?: PersonaAvatar | null;
  size?: number;
  /** Soft idle blink. */
  animate?: boolean;
  /** Working / answering — bounce + curious gaze. */
  busy?: boolean;
  className?: string;
}) {
  const resolved = resolveAvatar(name, avatar);
  const expression = busy ? "curious" : resolved.expression;
  const [blink, setBlink] = useState(false);
  const hue = agentHue(name);
  const live = animate || busy;

  useEffect(() => {
    if (!live) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const loop = () => {
      const wait = busy ? 400 + (hue % 400) : 2200 + (hue % 1800);
      timer = setTimeout(() => {
        if (cancelled) return;
        setBlink(true);
        timer = setTimeout(() => {
          if (cancelled) return;
          setBlink(false);
          loop();
        }, busy ? 80 : 120);
      }, wait);
    };
    loop();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [live, busy, hue]);

  const [left, right] = eyesFor(expression, live && blink);
  const cls = ["agent-blob", busy ? "agent-blob--busy" : "", className].filter(Boolean).join(" ");

  return (
    <svg
      className={cls}
      viewBox="0 0 32 32"
      width={size}
      height={size}
      aria-hidden="true"
    >
      <path d={BODY[resolved.shape]} fill={resolved.color} />
      <ellipse
        cx={left.cx}
        cy={left.cy}
        rx={left.rx}
        ry={left.ry}
        fill="#fff"
        transform={`rotate(${left.rot} ${left.cx} ${left.cy})`}
      />
      <ellipse
        cx={right.cx}
        cy={right.cy}
        rx={right.rx}
        ry={right.ry}
        fill="#fff"
        transform={`rotate(${right.rot} ${right.cx} ${right.cy})`}
      />
    </svg>
  );
}

export function AvatarPicker({
  name,
  value,
  onChange,
}: {
  name: string;
  value?: PersonaAvatar | null;
  onChange: (next: PersonaAvatar) => void;
}) {
  const current = resolveAvatar(name || "agent", value);
  const set = (patch: Partial<PersonaAvatar>) => onChange({ ...current, ...patch });

  return (
    <fieldset className="field avatar-picker">
      <legend>Avatar</legend>
      <div className="avatar-picker-preview">
        <AgentBlob name={name || "agent"} avatar={current} size={56} animate />
        <p className="muted small">Color, shape, and expression.</p>
      </div>
      <div className="avatar-picker-row" role="group" aria-label="Color">
        {BLOB_COLORS.map((c) => (
          <button
            key={c}
            type="button"
            className={`avatar-swatch${current.color === c ? " on" : ""}`}
            style={{ background: c }}
            aria-label={c}
            aria-pressed={current.color === c}
            onClick={() => set({ color: c })}
          />
        ))}
      </div>
      <div className="avatar-picker-row" role="group" aria-label="Shape">
        {BLOB_SHAPES.map((s) => (
          <button
            key={s.id}
            type="button"
            className={`chip${current.shape === s.id ? " on" : ""}`}
            aria-pressed={current.shape === s.id}
            onClick={() => set({ shape: s.id })}
          >
            <AgentBlob name={name || "agent"} avatar={{ ...current, shape: s.id }} size={22} />
            {s.label}
          </button>
        ))}
      </div>
      <div className="avatar-picker-row" role="group" aria-label="Expression">
        {BLOB_EXPRESSIONS.map((e) => (
          <button
            key={e.id}
            type="button"
            className={`chip${current.expression === e.id ? " on" : ""}`}
            aria-pressed={current.expression === e.id}
            onClick={() => set({ expression: e.id })}
          >
            <AgentBlob name={name || "agent"} avatar={{ ...current, expression: e.id }} size={22} />
            {e.label}
          </button>
        ))}
      </div>
    </fieldset>
  );
}
