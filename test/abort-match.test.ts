import { expect, test } from "vitest";
import { abortTargets } from "../harness/abort-match.ts";

test("a thread abort reaches its persona runs, an agent abort only that agent", () => {
  const threads = { c1: "team/a", c2: "team/a#Qa", c3: "team/a#Dev", c4: "team/ab", c5: "team/a#Qa2" };
  expect(abortTargets(threads, "team/a").sort()).toEqual(["c1", "c2", "c3", "c5"]);
  expect(abortTargets(threads, "team/a#Qa")).toEqual(["c2"]);
});
