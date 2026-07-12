import { describe, it, expect } from "vitest";
import { plan } from "./planner.js";
import { isInsufficientExceptionAnswer } from "./engine.js";
import type { PlannerInput } from "./types.js";
import type { InboundMessage } from "@carememory/im-core";
import type { AnswerConfidenceResult } from "./turn-manager.js";

function makeMessage(text: string): InboundMessage {
  return {
    platform: "test",
    channelId: "user_1",
    userId: "user_1",
    messageId: "msg_1",
    timestamp: new Date(),
    content: { type: "text", text, rawPayload: {} },
  };
}

function makeAnswerEvaluation(partial: Partial<AnswerConfidenceResult> = {}): AnswerConfidenceResult {
  return {
    isAnswer: true,
    confidence: 0.6,
    matchMethod: "text",
    reasoning: "test",
    ...partial,
  };
}

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

describe("isInsufficientExceptionAnswer", () => {
  it("flags very short replies as insufficient", () => {
    expect(isInsufficientExceptionAnswer(makeMessage("ok"), makeAnswerEvaluation())).toBe(true);
  });

  it("flags vague replies as insufficient", () => {
    expect(isInsufficientExceptionAnswer(makeMessage("I don't know"), makeAnswerEvaluation())).toBe(true);
    expect(isInsufficientExceptionAnswer(makeMessage("not sure"), makeAnswerEvaluation())).toBe(true);
    expect(isInsufficientExceptionAnswer(makeMessage("no idea"), makeAnswerEvaluation())).toBe(true);
  });

  it("flags low-confidence text answers as insufficient", () => {
    const evaluation = makeAnswerEvaluation({ confidence: 0.3, matchMethod: "text" });
    expect(isInsufficientExceptionAnswer(makeMessage("maybe a little"), evaluation)).toBe(true);
  });

  it("accepts substantive replies", () => {
    expect(
      isInsufficientExceptionAnswer(
        makeMessage("It started about 30 minutes after I used my inhaler"),
        makeAnswerEvaluation({ confidence: 0.8 })
      )
    ).toBe(false);
  });
});
