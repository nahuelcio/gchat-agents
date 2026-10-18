import { describe, expect, it } from "vitest";
import { answersFromText, formatQuestions, normalizeQuestions, questionCards } from "../src/questions.js";

const questions = normalizeQuestions([
  {
    question: "Which library?",
    header: "Library",
    multiSelect: false,
    options: [
      { label: "date-fns", description: "small" },
      { label: "luxon", description: "tz" },
    ],
  },
]);

describe("questions", () => {
  it("normalizes multiple and multiSelect shapes into one question", () => {
    expect(questions).toEqual([
      {
        header: "Library",
        question: "Which library?",
        options: [
          { label: "date-fns", description: "small" },
          { label: "luxon", description: "tz" },
        ],
      },
    ]);
    expect(normalizeQuestions([{ question: "x", header: "H", multiple: true, options: [{ label: "A" }, { label: "B" }] }])[0]?.multiple).toBe(true);
  });

  it("maps a number, a label, or free text onto the question", () => {
    expect(answersFromText(questions, "1")).toEqual({ "Which library?": "date-fns" });
    expect(answersFromText(questions, "Luxon")).toEqual({ "Which library?": "luxon" });
    expect(answersFromText(questions, "moment")).toEqual({ "Which library?": "moment" });
  });

  it("renders a Google Chat card whose buttons send the option label", () => {
    const card = questionCards(questions)[0]?.card;
    const buttons = card?.sections?.[0]?.widgets?.find((w) => "buttonList" in w) as {
      buttonList: { buttons: { text: string; onClick: { action: { parameters: { value: string }[] } } }[] };
    };
    expect(card?.header?.title).toBe("Library");
    expect(buttons.buttonList.buttons.map((b) => b.onClick.action.parameters[0]?.value)).toEqual(["date-fns", "luxon"]);
    expect(formatQuestions(questions)).toContain("1. date-fns — small");
  });
});
