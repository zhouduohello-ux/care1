import { describe, it, expect } from "vitest";
import { plan } from "./planner.js";
import type { PlannerInput } from "./types.js";
import type { MedicationBaseline } from "./question-bank.js";

function baseInput(medications?: MedicationBaseline): PlannerInput {
  return {
    patientContext: {
      disease: "asthma",
      cycleId: "cycle_1",
      cycleDay: 1,
      narrativeSummary: "",
      recentObservations: [],
      openIssues: [],
      medications,
    },
    conversationContext: {
      currentIntent: "checkin_start",
      intentStack: [],
      questionsAskedThisSession: 0,
      budgetRemaining: 3,
      inExceptionMode: false,
    },
    temporalContext: {
      localTime: new Date().toISOString(),
      dayOfWeek: "Monday",
    },
  };
}

describe("planner", () => {
  it("asks the first check-in question when no topics are covered", async () => {
    const output = await plan(baseInput());
    expect(output.nextAction.type).toBe("ask");
    expect(output.nextAction.topic).toBe("nighttime_symptoms");
    expect(output.reasoning).toContain("Retrieved:");
  });

  it("moves to the next uncovered topic", async () => {
    const input = baseInput();
    input.patientContext.recentObservations = [
      { category: "symptom", concept: "nighttime_symptoms", value: "mild" },
    ];
    const output = await plan(input);
    expect(output.nextAction.type).toBe("ask");
    expect(output.nextAction.topic).toBe("reliever_use");
  });

  it("ends the session when all topics are covered", async () => {
    const input = baseInput();
    input.patientContext.recentObservations = [
      { category: "symptom", concept: "nighttime_symptoms", value: "mild" },
      { category: "medication", concept: "reliever_use", value: 1 },
      { category: "function", concept: "activity_limitation", value: "no" },
    ];
    const output = await plan(input);
    expect(output.nextAction.type).toBe("end_session");
  });

  it("ends the session when budget is exhausted", async () => {
    const input = baseInput();
    input.conversationContext.budgetRemaining = 0;
    const output = await plan(input);
    expect(output.nextAction.type).toBe("end_session");
  });

  it("enters exception mode and asks clarifying questions", async () => {
    const input = baseInput();
    input.conversationContext.inExceptionMode = true;
    input.patientContext.recentObservations = [
      { category: "adverse_event", concept: "possible_reaction", value: "rash" },
    ];
    const output = await plan(input);
    expect(output.nextAction.type).toBe("ask");
    expect(output.nextAction.topic).toMatch(/^exception_/);
    expect(output.safetyFlag).toBe("medium");
  });

  it("ends exception mode after 3 clarifying questions", async () => {
    const input = baseInput();
    input.conversationContext.inExceptionMode = true;
    input.conversationContext.exceptionQuestionsAsked = 3;
    const output = await plan(input);
    expect(output.nextAction.type).toBe("end_session");
  });

  it("prioritizes safety response for adverse event outside exception mode", async () => {
    const input = baseInput();
    input.patientContext.recentObservations = [
      { category: "adverse_event", concept: "possible_reaction", value: "rash" },
    ];
    const output = await plan(input);
    expect(output.nextAction.type).toBe("safety_response");
    expect(output.safetyFlag).toBe("high");
  });

  it("includes controller_adherence when the user has a controller", async () => {
    const medications: MedicationBaseline = { baseline: [{ name: "Seretide", type: "controller" }] };
    const input = baseInput(medications);
    input.conversationContext.budgetRemaining = 4;
    const output = await plan(input);
    expect(output.nextAction.type).toBe("ask");
    expect(output.nextAction.topic).toBe("nighttime_symptoms");

    // After core questions, adherence should be asked if budget remains.
    input.patientContext.recentObservations = [
      { category: "symptom", concept: "nighttime_symptoms", value: "none" },
      { category: "medication", concept: "reliever_use", value: 0 },
      { category: "function", concept: "activity_limitation", value: "no" },
    ];
    const adherenceOutput = await plan(input);
    expect(adherenceOutput.nextAction.type).toBe("ask");
    expect(adherenceOutput.nextAction.topic).toBe("controller_adherence");
    expect(adherenceOutput.nextAction.purpose).toContain("Seretide");
  });

  it("ends session after controller_adherence is covered", async () => {
    const medications: MedicationBaseline = { baseline: [{ name: "Seretide", type: "controller" }] };
    const input = baseInput(medications);
    input.patientContext.recentObservations = [
      { category: "symptom", concept: "nighttime_symptoms", value: "none" },
      { category: "medication", concept: "reliever_use", value: 0 },
      { category: "function", concept: "activity_limitation", value: "no" },
      { category: "medication", concept: "controller_adherence", value: "yes" },
    ];
    const output = await plan(input);
    expect(output.nextAction.type).toBe("end_session");
  });
});
