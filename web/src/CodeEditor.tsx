import { html } from "@codemirror/lang-html";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { markdown } from "@codemirror/lang-markdown";
import { python } from "@codemirror/lang-python";
import { StreamLanguage } from "@codemirror/language";
import { shell } from "@codemirror/legacy-modes/mode/shell";
import type { Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import CodeMirror from "@uiw/react-codemirror";
import { useCallback, useMemo, useRef } from "react";

export type EditorLang = "markdown" | "html" | "javascript" | "typescript" | "python" | "json" | "shell" | "text";

export function langFromPath(path: string): EditorLang {
  const p = path.replace(/\\/g, "/").toLowerCase();
  if (p.endsWith(".html") || p.endsWith(".htm")) return "html";
  if (p.endsWith(".py")) return "python";
  if (p.endsWith(".json")) return "json";
  if (p.endsWith(".ts") || p.endsWith(".tsx")) return "typescript";
  if (p.endsWith(".js") || p.endsWith(".jsx") || p.endsWith(".mjs") || p.endsWith(".cjs")) return "javascript";
  if (p.endsWith(".sh") || p.endsWith(".bash") || p.endsWith(".zsh")) return "shell";
  if (p.endsWith(".md") || p.endsWith(".markdown") || p.endsWith("skill.md")) return "markdown";
  return "text";
}

const BASIC_SETUP = {
  lineNumbers: true,
  foldGutter: true,
  highlightActiveLine: true,
  autocompletion: false,
  searchKeymap: true,
};

function extensionsFor(lang: EditorLang): Extension[] {
  const wrap = EditorView.lineWrapping;
  switch (lang) {
    case "html":
      return [html(), wrap];
    case "python":
      return [python(), wrap];
    case "json":
      return [json(), wrap];
    case "typescript":
      return [javascript({ typescript: true, jsx: true }), wrap];
    case "javascript":
      return [javascript({ jsx: true }), wrap];
    case "markdown":
      return [markdown(), wrap];
    case "shell":
      return [StreamLanguage.define(shell), wrap];
    default:
      return [wrap];
  }
}

export function CodeEditor({
  value,
  onChange,
  language = "text",
  path,
  placeholder,
  minHeight = 160,
  ariaLabel,
}: {
  value: string;
  onChange: (next: string) => void;
  language?: EditorLang;
  path?: string;
  placeholder?: string;
  minHeight?: number;
  ariaLabel?: string;
}) {
  const lang = path ? langFromPath(path) : language;
  // @uiw/react-codemirror reconfigures the editor whenever `extensions`,
  // `basicSetup` or `onChange` change identity. A fresh callback each keystroke
  // rebuilds the document and drops the caret at the end, which then scrolls
  // the page down to that caret.
  const extensions = useMemo(() => extensionsFor(lang), [lang]);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const handleChange = useCallback((next: string) => {
    onChangeRef.current(next);
  }, []);
  const min = `${minHeight}px`;
  return (
    <div className="code-editor" style={{ ["--code-min-h" as string]: min }} aria-label={ariaLabel}>
      <CodeMirror
        value={value}
        height="auto"
        minHeight={min}
        maxHeight="480px"
        theme="light"
        basicSetup={BASIC_SETUP}
        placeholder={placeholder}
        extensions={extensions}
        onChange={handleChange}
      />
    </div>
  );
}
