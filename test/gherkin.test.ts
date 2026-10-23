import { expect, test } from "vitest";
import { gherkinLine, isGherkin } from "../web/src/gherkin.ts";

test("classifies gherkin lines in English and Spanish", () => {
  expect(gherkinLine("  @smoke @login")).toEqual({ kind: "tag", text: "  @smoke @login" });
  expect(gherkinLine("# a note")).toEqual({ kind: "comment", text: "# a note" });
  expect(gherkinLine("Feature: Login")).toEqual({ kind: "heading", keyword: "Feature:", text: " Login" });
  expect(gherkinLine("  Escenario: entra")).toEqual({ kind: "heading", keyword: "  Escenario:", text: " entra" });
  expect(gherkinLine("    Given a user")).toEqual({ kind: "step", keyword: "    Given", text: " a user" });
  expect(gherkinLine("    Entonces ve el panel")).toEqual({ kind: "step", keyword: "    Entonces", text: " ve el panel" });
  expect(gherkinLine("    | a | b |")).toEqual({ kind: "table", text: "    | a | b |" });
  expect(gherkinLine("    whatever")).toEqual({ kind: "plain", text: "    whatever" });
  expect(gherkinLine("    Andrew logs in")).toEqual({ kind: "plain", text: "    Andrew logs in" });
});

test("detects untagged gherkin blocks", () => {
  expect(isGherkin(undefined, "Feature: X\n  Scenario: Y\n    Given z")).toBe(true);
  expect(isGherkin("gherkin", "anything")).toBe(true);
  expect(isGherkin(undefined, "const a = 1;\nconst b = 2;")).toBe(false);
});
