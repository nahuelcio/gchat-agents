import type { PostMessageBody } from "./chat-client.js";
import type { AgentQuestion } from "./driver/types.js";

export function normalizeQuestions(raw: unknown): AgentQuestion[] {
  if (!Array.isArray(raw)) return [];
  const out: AgentQuestion[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const q = item as Record<string, unknown>;
    const question = typeof q.question === "string" ? q.question.trim() : "";
    const header = typeof q.header === "string" && q.header.trim() ? q.header.trim() : "Question";
    const options = (Array.isArray(q.options) ? q.options : []).flatMap((o) => {
      if (!o || typeof o !== "object") return [];
      const label = typeof (o as { label?: unknown }).label === "string" ? (o as { label: string }).label.trim() : "";
      if (!label) return [];
      const description =
        typeof (o as { description?: unknown }).description === "string"
          ? (o as { description: string }).description.trim()
          : undefined;
      return [{ label, ...(description && { description }) }];
    });
    if (!question || options.length < 2) continue;
    const multiple = q.multiple === true || q.multiSelect === true;
    out.push({ header, question, options, ...(multiple && { multiple: true }) });
  }
  return out;
}

export function formatQuestions(questions: AgentQuestion[]): string {
  const body = questions
    .map((q) => {
      const lines = [
        q.header,
        q.question,
        ...q.options.map((o, i) => `${i + 1}. ${o.label}${o.description ? ` — ${o.description}` : ""}`),
      ];
      if (q.multiple) lines.push("You can pick more than one.");
      return lines.join("\n");
    })
    .join("\n\n");
  return `${body}\n\nReply with the number, the option, or your own answer.`;
}

export function answersFromText(questions: AgentQuestion[], text: string): Record<string, string> {
  const lines = questions.length === 1 ? [text.trim()] : text.split(/\n/).map((s) => s.trim()).filter(Boolean);
  const answers: Record<string, string> = {};
  questions.forEach((q, i) => {
    const raw = (lines[i] ?? (questions.length === 1 ? lines[0] : "") ?? "").replace(/^\d+\.\s*/, "");
    answers[q.question] = resolveChoice(q, raw);
  });
  return answers;
}

function resolveChoice(q: AgentQuestion, raw: string): string {
  const parts = raw.split(",").map((s) => s.trim()).filter(Boolean);
  if (parts.length === 0) return raw.trim();
  const labels = parts.map((part) => {
    const n = Number(part);
    if (Number.isInteger(n) && n >= 1 && n <= q.options.length) return q.options[n - 1]!.label;
    const match = q.options.find((o) => o.label.toLowerCase() === part.toLowerCase());
    return match?.label ?? part;
  });
  return labels.join(", ");
}

/** Fold a chat reply into the next prompt when the agent process is already gone. */
export function continuation(questions: AgentQuestion[], text: string, sender?: string): string {
  const answers = answersFromText(questions, text);
  const parts = questions.map((q) => `"${q.question}"="${answers[q.question] ?? "Unanswered"}"`);
  const who = sender ? `${sender} answered` : "The user answered";
  return `${who} your questions: ${parts.join(", ")}. Continue with those answers.`;
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** One Google Chat card. Buttons only when a single question can be answered in one click. */
export function questionCards(questions: AgentQuestion[]): NonNullable<PostMessageBody["cardsV2"]> {
  const single = questions.length === 1 && !questions[0]?.multiple ? questions[0] : undefined;
  return [
    {
      cardId: "agent-question",
      card: {
        header: { title: questions[0]?.header ?? "Question", subtitle: "The agent is waiting for an answer" },
        sections: [
          {
            widgets: [
              ...questions.map((q) => ({
                textParagraph: {
                  text: `<b>${esc(q.question)}</b><br>${q.options
                    .map((o, i) => `${i + 1}. <b>${esc(o.label)}</b>${o.description ? ` — ${esc(o.description)}` : ""}`)
                    .join("<br>")}`,
                },
              })),
              ...(single
                ? [
                    {
                      buttonList: {
                        buttons: single.options.map((o) => ({
                          text: o.label.slice(0, 50),
                          onClick: {
                            action: {
                              function: "answerQuestion",
                              parameters: [{ key: "answer", value: o.label }],
                            },
                          },
                        })),
                      },
                    },
                  ]
                : []),
            ],
          },
        ],
      },
    },
  ];
}
