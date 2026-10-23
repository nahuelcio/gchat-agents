import { highlight } from "./highlight";

export function CodeBlock({ text, lang }: { text: string; lang?: string }) {
  const spans = highlight(text, lang);
  return (
    <pre className="message-pre">
      {lang && <span className="code-lang">{lang}</span>}
      <code>{spans ? spans.map((s, i) => (s.cls ? <span key={i} className={s.cls}>{s.text}</span> : s.text)) : text}</code>
    </pre>
  );
}
