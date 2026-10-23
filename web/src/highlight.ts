import { classHighlighter, highlightCode } from "@lezer/highlight";
import { parser as jsParser } from "@lezer/javascript";
import { parser as jsonParser } from "@lezer/json";
import { parser as pythonParser } from "@lezer/python";
import { parser as htmlParser } from "@lezer/html";
import { parser as cssParser } from "@lezer/css";
import { StreamLanguage } from "@codemirror/language";
import { shell } from "@codemirror/legacy-modes/mode/shell";

type Parser = { parse(input: string): import("@lezer/common").Tree };

const ts = jsParser.configure({ dialect: "ts" });
const tsx = jsParser.configure({ dialect: "ts jsx" });
const sh = StreamLanguage.define(shell).parser;

const PARSERS: Record<string, Parser> = {
  ts, typescript: ts, tsx, js: jsParser, javascript: jsParser, jsx: tsx, mjs: jsParser,
  json: jsonParser, jsonc: jsonParser,
  py: pythonParser, python: pythonParser,
  html: htmlParser, xml: htmlParser, css: cssParser, scss: cssParser,
  sh, bash: sh, shell: sh, zsh: sh, console: sh,
};

export type Span = { text: string; cls?: string };

/** Classed spans for a fenced code block, or null when the language is unknown. */
export function highlight(code: string, lang: string | undefined): Span[] | null {
  const parser = lang ? PARSERS[lang.toLowerCase()] : undefined;
  if (!parser) return null;
  const out: Span[] = [];
  highlightCode(
    code,
    parser.parse(code),
    classHighlighter,
    (text, cls) => out.push(cls ? { text, cls } : { text }),
    () => out.push({ text: "\n" }),
  );
  return out;
}
