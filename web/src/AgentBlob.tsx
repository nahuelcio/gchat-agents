import { useEffect, useState } from "react";
import { agentHue, BOT_NAME } from "./agent-color";

/** Customizable blob face for agents (inspired by bloub-style morph avatars). */
export type BlobShape = "round" | "soft" | "tall" | "bean" | "cloud" | "ghost" | "squircle" | "flower" | "heart" | "drop" | "hex" | "star" | "pebble";
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
  { id: "cloud", label: "Cloud" },
  { id: "ghost", label: "Ghost" },
  { id: "squircle", label: "Squircle" },
  { id: "flower", label: "Flower" },
  { id: "heart", label: "Heart" },
  { id: "drop", label: "Drop" },
  { id: "hex", label: "Hex" },
  { id: "star", label: "Star" },
  { id: "pebble", label: "Pebble" },
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
  cloud: "M9 26.6C5.3 26.6 2.4 23.7 2.4 20.1c0-3.1 2.2-5.7 5.2-6.3C8.2 9.4 11.8 5.8 16.2 5.8c3.7 0 6.9 2.4 8 5.9 3.4.3 5.9 3.2 5.9 6.7 0 4.5-3.5 8.2-7.9 8.2H9Z",
  ghost: "M16 3c6.6 0 11.6 5 11.6 11.6V28l-3.9-2.6-3.8 2.6-3.9-2.6-3.9 2.6-3.8-2.6L4.4 28V14.6C4.4 8 9.4 3 16 3Z",
  squircle: "M16 3c9.6 0 13 3.4 13 13s-3.4 13-13 13S3 25.6 3 16 6.4 3 16 3Z",
  flower: "M16 2.6c2 0 3.4 1.6 4.3 3.1 1.7-.5 3.8-.5 5 .9 1.3 1.3 1.3 3.3.9 5 1.5.9 3.1 2.4 3.1 4.4s-1.6 3.5-3.1 4.4c.4 1.7.4 3.7-.9 5-1.3 1.3-3.3 1.4-5 .9-.9 1.5-2.3 3.1-4.3 3.1s-3.5-1.6-4.4-3.1c-1.7.5-3.7.4-5-.9s-1.3-3.3-.9-5C4.2 19.5 2.6 18 2.6 16s1.6-3.5 3.1-4.4c-.4-1.7-.4-3.7.9-5 1.3-1.4 3.3-1.4 5-.9.9-1.5 2.4-3.1 4.4-3.1Z",
  heart: "M16 28.4C9.6 24.2 3 19.2 3 12.2 3 8.3 6 5.4 9.6 5.4c2.6 0 4.9 1.5 6.4 3.6 1.5-2.1 3.8-3.6 6.4-3.6 3.6 0 6.6 2.9 6.6 6.8 0 7-6.6 12-13 16.2Z",
  drop: "M16 2.4c4.2 5.2 11.4 11.2 11.4 17.4 0 5.8-5 9.8-11.4 9.8S4.6 25.6 4.6 19.8C4.6 13.6 11.8 7.6 16 2.4Z",
  hex: "M14.2 3.3c1.1-.6 2.5-.6 3.6 0l9 5.2c1.1.6 1.8 1.8 1.8 3.1v8.8c0 1.3-.7 2.5-1.8 3.1l-9 5.2c-1.1.6-2.5.6-3.6 0l-9-5.2c-1.1-.6-1.8-1.8-1.8-3.1v-8.8c0-1.3.7-2.5 1.8-3.1l9-5.2Z",
  star: "M14.3 3.6c.7-1.5 2.7-1.5 3.4 0l2.6 5.4 5.9.9c1.6.2 2.2 2.2 1.1 3.3l-4.3 4.2 1 5.9c.3 1.6-1.4 2.8-2.8 2.1L16 22.6l-5.3 2.8c-1.4.7-3.1-.5-2.8-2.1l1-5.9-4.3-4.2c-1.1-1.1-.5-3.1 1.1-3.3l5.9-.9 2.7-5.4Z",
  pebble: "M15 4.2c6.4-.6 12.6 3 13.6 9.4.9 5.8-2.6 11.6-8.6 13.6-5.6 1.9-12.4.4-15.4-4.6C1.8 18.2 3 11.6 7 8c2.2-2.2 5-3.5 8-3.8Z",
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
    shape: BLOB_SHAPES[h % 4]!.id,
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
      <path d={BODY[resolved.shape] ?? BODY.round} fill={resolved.color} />
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
