import { describe, it, expect } from "vitest";
import {
  CHECKIN_QUESTIONS,
  CORE_CHECKIN_QUESTIONS,
  EXCEPTION_QUESTIONS,
  buildCheckInQuestions,
  getCheckInQuestion,
  hasControllerMedication,
  type MedicationBaseline,
} from "./question-bank.js";
import { enGB } from "./dialogue-locales/en-GB.js";
import { cyGB } from "./dialogue-locales/cy-GB.js";

describe("question bank", () => {
  it("has unique topics for core check-in questions", () => {
    const topics = CORE_CHECKIN_QUESTIONS.map((q) => q.topic);
    expect(new Set(topics).size).toBe(topics.length);
  });

  it("CHECKIN_QUESTIONS is an alias for core questions", () => {
    expect(CHECKIN_QUESTIONS).toEqual(CORE_CHECKIN_QUESTIONS);
  });

  it("covers all core topics referenced in en-GB option labels", () => {
    for (const question of CORE_CHECKIN_QUESTIONS) {
      if (question.options) {
        expect(enGB.optionLabels[question.topic]).toBeDefined();
        expect(enGB.optionLabels[question.topic].length).toBe(question.options.length);
      }
    }
  });

  it("covers all core topics referenced in cy-GB option labels", () => {
    for (const question of CORE_CHECKIN_QUESTIONS) {
      if (question.options) {
        expect(cyGB.optionLabels[question.topic]).toBeDefined();
        expect(cyGB.optionLabels[question.topic].length).toBe(question.options.length);
      }
    }
  });

  it("has options matching labels order in every supported locale", () => {
    const locales = [enGB, cyGB];
    for (const locale of locales) {
      for (const question of CORE_CHECKIN_QUESTIONS) {
        if (!question.options) continue;
        const labels = locale.optionLabels[question.topic];
        expect(labels).toBeDefined();
        expect(labels.length).toBe(question.options.length);
      }
    }
  });

  it("adds a controller_adherence question when the user has a controller", () => {
    const medications: MedicationBaseline = {
      baseline: [{ name: "Seretide", type: "controller" }],
    };
    const questions = buildCheckInQuestions(medications);
    const adherence = questions.find((q) => q.topic === "controller_adherence");
    expect(adherence).toBeDefined();
    expect(adherence!.purpose).toContain("Seretide");
    expect(adherence!.options).toEqual(["adherence_yes", "adherence_no", "adherence_skip"]);
  });

  it("does not add a controller_adherence question when there is no controller", () => {
    const medications: MedicationBaseline = {
      baseline: [{ name: "Ventolin", type: "reliever" }],
    };
    const questions = buildCheckInQuestions(medications);
    expect(questions.some((q) => q.topic === "controller_adherence")).toBe(false);
    expect(questions).toEqual(CORE_CHECKIN_QUESTIONS);
  });

  it("returns core questions when medications are empty", () => {
    expect(buildCheckInQuestions({ baseline: [] })).toEqual(CORE_CHECKIN_QUESTIONS);
    expect(buildCheckInQuestions(undefined)).toEqual(CORE_CHECKIN_QUESTIONS);
  });

  it("looks up questions using the dynamic builder", () => {
    const medications: MedicationBaseline = {
      baseline: [{ name: "Fostair", type: "controller" }],
    };
    expect(getCheckInQuestion("controller_adherence", medications)?.topic).toBe("controller_adherence");
    expect(getCheckInQuestion("controller_adherence")).toBeUndefined();
  });

  it("detects controller medication presence", () => {
    expect(hasControllerMedication({ baseline: [{ name: "Seretide", type: "controller" }] })).toBe(true);
    expect(hasControllerMedication({ baseline: [{ name: "Ventolin", type: "reliever" }] })).toBe(false);
    expect(hasControllerMedication(undefined)).toBe(false);
  });

  it("has at least one exception question", () => {
    expect(EXCEPTION_QUESTIONS.length).toBeGreaterThan(0);
  });
});
