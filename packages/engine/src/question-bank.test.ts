import { describe, it, expect } from "vitest";
import { CHECKIN_QUESTIONS, EXCEPTION_QUESTIONS } from "./question-bank.js";
import { enGB } from "./dialogue-locales/en-GB.js";
import { cyGB } from "./dialogue-locales/cy-GB.js";

describe("question bank", () => {
  it("has unique topics for check-in questions", () => {
    const topics = CHECKIN_QUESTIONS.map((q) => q.topic);
    expect(new Set(topics).size).toBe(topics.length);
  });

  it("covers all topics referenced in en-GB option labels", () => {
    for (const question of CHECKIN_QUESTIONS) {
      if (question.options) {
        expect(enGB.optionLabels[question.topic]).toBeDefined();
        expect(enGB.optionLabels[question.topic].length).toBe(question.options.length);
      }
    }
  });

  it("covers all topics referenced in cy-GB option labels", () => {
    for (const question of CHECKIN_QUESTIONS) {
      if (question.options) {
        expect(cyGB.optionLabels[question.topic]).toBeDefined();
        expect(cyGB.optionLabels[question.topic].length).toBe(question.options.length);
      }
    }
  });

  it("has options matching labels order in every supported locale", () => {
    const locales = [enGB, cyGB];
    for (const locale of locales) {
      for (const question of CHECKIN_QUESTIONS) {
        if (!question.options) continue;
        const labels = locale.optionLabels[question.topic];
        expect(labels).toBeDefined();
        expect(labels.length).toBe(question.options.length);
      }
    }
  });

  it("has at least one exception question", () => {
    expect(EXCEPTION_QUESTIONS.length).toBeGreaterThan(0);
  });
});
