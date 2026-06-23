import { describe, it, expect } from "vitest";
import { plan } from "./planner.js";
import type { PlannerInput } from "./types.js";

function makeInput(exceptionQuestionsAsked = 0, budgetRemaining = 3): PlannerInput {
  return {
    patientContext: {
      disease: "asthma",
      cycleId: "cycle_1",
      cycleDay: 5,
      narrativeSummary: "",
      recentObservations: [],
      openIssues: [],
    },
    conversationContext: {
      currentIntent: "answer",
      intentStack: [],
      questionsAskedThisSession: 1,
      budgetRemaining,
      inExceptionMode: true,
      exceptionQuestionsAsked,
    },
    temporalContext: {
      localTime: new Date().toISOString(),
      dayOfWeek: "Monday",
    },
  };
}

describe("exception mode planner", () => {
  it("asks the first clarifying question", async () => {
    const output = await plan(makeInput(0, 3));
    expect(output.nextAction.type).toBe("ask");
    expect(output.nextAction.topic).toBe("exception_clarification");
    expect(output.safetyFlag).toBe("medium");
  });

  it("asks the second clarifying question after one answered", async () => {
    const output = await plan(makeInput(1, 2));
    expect(output.nextAction.type).toBe("ask");
    expect(output.nextAction.topic).toBe("exception_impact");
  });

  it("ends the session with safety guidance after 3 clarifying questions", async () => {
    const output = await plan(makeInput(3, 0));
    expect(output.nextAction.type).toBe("end_session");
    expect(output.nextAction.purpose.toLowerCase()).toContain("gp");
  });
});
