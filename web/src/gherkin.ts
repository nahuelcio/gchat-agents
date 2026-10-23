export type GherkinLine =
  | { kind: "tag" | "comment" | "table" | "plain"; text: string }
  | { kind: "heading" | "step"; keyword: string; text: string };

const HEADING =
  /^(\s*(?:Feature|Background|Scenario Outline|Scenario Template|Scenario|Example|Examples|Scenarios|Rule|Característica|Caracteristica|Antecedentes|Esquema del escenario|Escenario|Ejemplos|Regla):)(.*)$/;
const STEP = /^(\s*(?:Given|When|Then|And|But|Dado|Dada|Dados|Dadas|Cuando|Entonces|Y|E|Pero|\*))(\s.*|)$/;

export function gherkinLine(line: string): GherkinLine {
  const t = line.trimStart();
  if (t.startsWith("@")) return { kind: "tag", text: line };
  if (t.startsWith("#")) return { kind: "comment", text: line };
  if (t.startsWith("|")) return { kind: "table", text: line };
  const h = HEADING.exec(line);
  if (h) return { kind: "heading", keyword: h[1]!, text: h[2]! };
  const s = STEP.exec(line);
  if (s) return { kind: "step", keyword: s[1]!, text: s[2]! };
  return { kind: "plain", text: line };
}

export function isGherkin(lang: string | undefined, text: string): boolean {
  if (lang) return ["gherkin", "feature", "cucumber"].includes(lang.toLowerCase());
  return /^\s*(Feature|Característica|Caracteristica):/m.test(text) && /^\s*(Scenario|Escenario)/m.test(text);
}
