import { expect, test } from "vitest";
import { highlight } from "../web/src/highlight.ts";

test("highlights a typescript block into classed spans that keep the text", () => {
  const code = "getHeaderKeys(): string[] {\n  return ['DATE']; // header\n}";
  const spans = highlight(code, "ts")!;
  expect(spans.map((s) => s.text).join("")).toBe(code);
  expect(spans.some((s) => s.cls?.includes("tok-string") && s.text === "'DATE'")).toBe(true);
  expect(spans.some((s) => s.cls?.includes("tok-comment"))).toBe(true);
  expect(spans.some((s) => s.cls?.includes("tok-keyword") && s.text === "return")).toBe(true);
});

test("unknown languages are left plain", () => {
  expect(highlight("x", "cobol")).toBeNull();
  expect(highlight("x", undefined)).toBeNull();
});
