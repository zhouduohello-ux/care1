import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { InboundMessage, OutboundMessage } from "@carememory/im-core";
import type { PerceptionResult, PlannerOutput } from "./types.js";
import { Prisma } from "@carememory/db";
import type { LLMClient } from "./llm.js";
import {
  pendingQuestionFromPlannerOutput,
  isAnswerToPendingQuestion,
  isAnswerRelevantWithLlm,
  buildRepromptMessage,
  buildClarificationMessage,
  looksLikeClarificationRequest,
  looksLikeSkipRequest,
  recordSkippedQuestion,
  classifyNonAnswer,
  getTurnState,
  recordReprompt,
  clearPendingQuestion,
  setPendingQuestion,
  getMaxReprompts,
  DEFAULT_MAX_REPROMPTS,
} from "./turn-manager.js";

function makePlannerOutput(partial: Partial<PlannerOutput["nextAction"]> & { type: PlannerOutput["nextAction"]["type"] }): PlannerOutput {
  return {
    reasoning: "test",
    sessionObjective: "test",
    nextAction: {
      type: partial.type,
      topic: partial.topic ?? "test",
      purpose: partial.purpose ?? "Test question?",
      expectedResponseType: partial.expectedResponseType,
      options: partial.options,
      budgetCost: partial.budgetCost ?? 1,
    },
    safetyFlag: "none",
    updatePatientState: {},
  };
}

function makePerception(partial: Partial<PerceptionResult> = {}): PerceptionResult {
  return {
    messageId: "msg_1",
    timestamp: new Date(),
    traceId: "trace_1",
    intent: { primary: "answer", confidence: 1 },
    extractedObservations: [],
    anomalies: [],
    safetyFlags: [],
    rawText: partial.rawText ?? "",
    ...partial,
  };
}

function makeInbound(content: Partial<InboundMessage["content"]> & { text?: string }): InboundMessage {
  return {
    platform: "test",
    channelId: "user_1",
    userId: "user_1",
    messageId: "msg_1",
    timestamp: new Date(),
    content: {
      type: "text",
      text: content.text ?? "",
      rawPayload: {},
      ...content,
    } as InboundMessage["content"],
  };
}

describe("pendingQuestionFromPlannerOutput", () => {
  it("returns undefined for non-ask actions", () => {
    const output = makePlannerOutput({ type: "end_session", purpose: "Thanks." });
    expect(pendingQuestionFromPlannerOutput(output)).toBeUndefined();
  });

  it("returns pending question for ask action", () => {
    const output = makePlannerOutput({
      type: "ask",
      topic: "activity_limitation",
      expectedResponseType: "single_choice",
      options: ["activity_no", "activity_yes"],
    });
    const pending = pendingQuestionFromPlannerOutput(output);
    expect(pending).toBeDefined();
    expect(pending?.topic).toBe("activity_limitation");
    expect(pending?.expectedResponseType).toBe("single_choice");
    expect(pending?.options).toEqual(["activity_no", "activity_yes"]);
  });
});

describe("isAnswerToPendingQuestion", () => {
  it("accepts any text when expectedResponseType is text", () => {
    const pending = { topic: "exception_clarification", purpose: "Tell me more.", expectedResponseType: "text" as const, askedAt: "" };
    expect(isAnswerToPendingQuestion(makeInbound({ text: "blah" }), makePerception(), pending)).toBe(true);
  });

  it("accepts button reply matching an option", () => {
    const pending = { topic: "activity_limitation", purpose: "Limited?", expectedResponseType: "single_choice" as const, options: ["activity_no", "activity_yes"], askedAt: "" };
    expect(
      isAnswerToPendingQuestion(makeInbound({ type: "button_reply", buttonId: "activity_yes" }), makePerception(), pending)
    ).toBe(true);
  });

  it("rejects button reply not matching any option", () => {
    const pending = { topic: "activity_limitation", purpose: "Limited?", expectedResponseType: "single_choice" as const, options: ["activity_no", "activity_yes"], askedAt: "" };
    expect(
      isAnswerToPendingQuestion(makeInbound({ type: "button_reply", buttonId: "unknown" }), makePerception(), pending)
    ).toBe(false);
  });

  it("accepts text matching a single_choice option id", () => {
    const pending = { topic: "activity_limitation", purpose: "Limited?", expectedResponseType: "single_choice" as const, options: ["activity_no", "activity_yes"], askedAt: "" };
    expect(isAnswerToPendingQuestion(makeInbound({ text: "activity_yes" }), makePerception(), pending)).toBe(true);
  });

  it("accepts scale digit 1-5", () => {
    const pending = { topic: "severity", purpose: "Rate severity.", expectedResponseType: "scale" as const, options: ["1", "2", "3", "4", "5"], askedAt: "" };
    expect(isAnswerToPendingQuestion(makeInbound({ text: "3" }), makePerception(), pending)).toBe(true);
    expect(isAnswerToPendingQuestion(makeInbound({ text: "6" }), makePerception(), pending)).toBe(false);
  });

  it("accepts scale described with words", () => {
    const pending = { topic: "severity", purpose: "Rate severity.", expectedResponseType: "scale" as const, options: ["1", "2", "3", "4", "5"], askedAt: "" };
    expect(isAnswerToPendingQuestion(makeInbound({ text: "severe" }), makePerception(), pending, "en-GB")).toBe(true);
    expect(isAnswerToPendingQuestion(makeInbound({ text: "very bad" }), makePerception(), pending, "en-GB")).toBe(true);
    expect(isAnswerToPendingQuestion(makeInbound({ text: "okay" }), makePerception(), pending, "en-GB")).toBe(true);
  });

  it("accepts single_choice by synonym", () => {
    const pending = { topic: "nighttime_symptoms", purpose: "Night symptoms?", expectedResponseType: "single_choice" as const, options: ["night_none", "night_mild", "night_disturbed", "night_woke_up"], askedAt: "" };
    expect(isAnswerToPendingQuestion(makeInbound({ text: "woke me up" }), makePerception(), pending, "en-GB")).toBe(true);
    expect(isAnswerToPendingQuestion(makeInbound({ text: "kept me awake" }), makePerception(), pending, "en-GB")).toBe(true);
    expect(isAnswerToPendingQuestion(makeInbound({ text: "none" }), makePerception(), pending, "en-GB")).toBe(true);
  });

  it("accepts multi_select by synonym and natural language", () => {
    const pending = { topic: "triggers", purpose: "Triggers?", expectedResponseType: "multi_select" as const, options: ["pollen", "dust", "exercise"], askedAt: "" };
    expect(isAnswerToPendingQuestion(makeInbound({ text: "pollen and exercise" }), makePerception(), pending, "en-GB")).toBe(true);
    expect(isAnswerToPendingQuestion(makeInbound({ text: "pollen, dust" }), makePerception(), pending, "en-GB")).toBe(true);
    expect(isAnswerToPendingQuestion(makeInbound({ text: "pollen and smoke" }), makePerception(), pending, "en-GB")).toBe(false);
  });

  it("accepts multi_select when all tokens match options", () => {
    const pending = { topic: "triggers", purpose: "Triggers?", expectedResponseType: "multi_select" as const, options: ["pollen", "dust", "exercise"], askedAt: "" };
    expect(isAnswerToPendingQuestion(makeInbound({ text: "pollen, dust" }), makePerception(), pending)).toBe(true);
    expect(isAnswerToPendingQuestion(makeInbound({ text: "pollen, smoke" }), makePerception(), pending)).toBe(false);
  });

  it("replies asking their own question are not answers", () => {
    const pending = { topic: "activity_limitation", purpose: "Limited?", expectedResponseType: "single_choice" as const, options: ["activity_no", "activity_yes"], askedAt: "" };
    expect(isAnswerToPendingQuestion(makeInbound({ text: "Can I skip?" }), makePerception({ intent: { primary: "question", confidence: 1 } }), pending)).toBe(false);
  });

  it("accepts free-text when perception extracts the pending topic", () => {
    const pending = { topic: "activity_limitation", purpose: "Limited?", expectedResponseType: "single_choice" as const, options: ["activity_no", "activity_yes"], askedAt: "" };
    const perception = makePerception({
      extractedObservations: [{ category: "function", concept: "activity_limitation", value: "yes", confidence: 1, extractedBy: "rule" }],
    });
    expect(isAnswerToPendingQuestion(makeInbound({ text: "I couldn't run today" }), perception, pending)).toBe(true);
  });
});

describe("classifyNonAnswer", () => {
  it("classifies question intent", () => {
    expect(classifyNonAnswer(makePerception({ intent: { primary: "question", confidence: 1 } }))).toBe("intent_question");
  });

  it("classifies option mismatch by default", () => {
    expect(classifyNonAnswer(makePerception())).toBe("option_mismatch");
  });
});

describe("buildRepromptMessage", () => {
  it("renders a reprompt for a pending single_choice question", async () => {
    const pending = {
      topic: "activity_limitation",
      purpose: "Did asthma limit your activities?",
      expectedResponseType: "single_choice" as const,
      options: ["activity_no", "activity_yes"],
      askedAt: "",
    };
    const message = await buildRepromptMessage("user_1", pending, 1, {});
    expect(message.content.type).toBe("buttons");
    expect(message.content.text).toContain("Did asthma limit your activities?");
    expect(message.content.buttons?.map((b) => b.id)).toEqual(["activity_no", "activity_yes"]);
  });

  it("uses a different prefix on the second reprompt", async () => {
    const pending = { topic: "severity", purpose: "Rate severity.", expectedResponseType: "text" as const, askedAt: "" };
    const first = await buildRepromptMessage("user_1", pending, 1, {});
    const second = await buildRepromptMessage("user_1", pending, 2, {});
    expect(first.content.text).toContain("I didn't catch that.");
    expect(second.content.text).toContain("Just to confirm:");
  });
});

describe("getTurnState", () => {
  it("returns pending question and reprompt count from CheckIn", async () => {
    const pending = { topic: "reliever_use", purpose: "How often?", expectedResponseType: "single_choice" as const, options: ["reliever_0"], askedAt: "2026-07-11T00:00:00.000Z" };
    const prisma = {
      checkIn: {
        findUnique: vi.fn().mockResolvedValue({ pendingQuestion: pending, repromptCount: 1 }),
      },
    } as unknown as import("@carememory/db").PrismaClient;

    const result = await getTurnState(prisma, "checkin_1");
    expect(result.pendingQuestion).toEqual(pending);
    expect(result.repromptCount).toBe(1);
    expect(prisma.checkIn.findUnique).toHaveBeenCalledWith({
      where: { id: "checkin_1" },
      select: { pendingQuestion: true, repromptCount: true },
    });
  });

  it("returns zero reprompt count when no check-in exists", async () => {
    const prisma = {
      checkIn: { findUnique: vi.fn().mockResolvedValue(null) },
    } as unknown as import("@carememory/db").PrismaClient;
    expect(await getTurnState(prisma, "checkin_1")).toEqual({ repromptCount: 0 });
  });
});

describe("recordReprompt", () => {
  it("updates CheckIn and creates a turn_reprompt event", async () => {
    const pending = { topic: "reliever_use", purpose: "How often?", expectedResponseType: "single_choice" as const, options: ["reliever_0"], askedAt: "" };
    const checkInUpdate = vi.fn().mockResolvedValue(undefined);
    const eventCreate = vi.fn().mockResolvedValue(undefined);
    const prisma = {
      checkIn: { update: checkInUpdate },
      event: { create: eventCreate },
    } as unknown as import("@carememory/db").PrismaClient;

    await recordReprompt(prisma, "user_1", "cycle_1", "checkin_1", pending, 2, "option_mismatch", new Date("2026-07-11T00:00:00Z"), "trace_1");

    expect(checkInUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "checkin_1" },
        data: expect.objectContaining({ repromptCount: 2 }),
      })
    );
    expect(eventCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          userId: "user_1",
          cycleId: "cycle_1",
          checkInId: "checkin_1",
          type: "turn_reprompt",
          traceId: "trace_1",
        }),
      })
    );
  });
});

describe("clearPendingQuestion", () => {
  it("clears pending question and resets reprompt count", async () => {
    const checkInUpdate = vi.fn().mockResolvedValue(undefined);
    const prisma = { checkIn: { update: checkInUpdate } } as unknown as import("@carememory/db").PrismaClient;
    await clearPendingQuestion(prisma, "checkin_1");
    expect(checkInUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "checkin_1" },
        data: expect.objectContaining({ repromptCount: 0 }),
      })
    );
  });
});

describe("setPendingQuestion", () => {
  it("sets pending question and resets reprompt count", async () => {
    const pending = { topic: "reliever_use", purpose: "How often?", expectedResponseType: "single_choice" as const, options: ["reliever_0"], askedAt: "" };
    const checkInUpdate = vi.fn().mockResolvedValue(undefined);
    const prisma = { checkIn: { update: checkInUpdate } } as unknown as import("@carememory/db").PrismaClient;
    await setPendingQuestion(prisma, "checkin_1", pending);
    expect(checkInUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "checkin_1" },
        data: expect.objectContaining({ repromptCount: 0 }),
      })
    );
  });
});

describe("getMaxReprompts", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.PENDING_QUESTION_MAX_REPROMPTS;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("defaults to 2", () => {
    expect(getMaxReprompts()).toBe(DEFAULT_MAX_REPROMPTS);
    expect(DEFAULT_MAX_REPROMPTS).toBe(2);
  });

  it("reads from PENDING_QUESTION_MAX_REPROMPTS", () => {
    process.env.PENDING_QUESTION_MAX_REPROMPTS = "5";
    expect(getMaxReprompts()).toBe(5);
  });

  it("falls back to default for invalid values", () => {
    process.env.PENDING_QUESTION_MAX_REPROMPTS = "not-a-number";
    expect(getMaxReprompts()).toBe(2);
    process.env.PENDING_QUESTION_MAX_REPROMPTS = "-1";
    expect(getMaxReprompts()).toBe(2);
    process.env.PENDING_QUESTION_MAX_REPROMPTS = "1.5";
    expect(getMaxReprompts()).toBe(2);
  });
});

function mockLlm(responseJson: string): LLMClient {
  return {
    modelName: "mock-relevance",
    complete: vi.fn().mockResolvedValue({
      content: responseJson,
      usage: { promptTokens: 20, completionTokens: 5, totalTokens: 25 },
    }),
  };
}

describe("isAnswerRelevantWithLlm", () => {
  const pending = { topic: "activity_limitation", purpose: "Were you limited?", expectedResponseType: "single_choice" as const, options: ["activity_no", "activity_yes"], askedAt: "" };

  it("returns true when LLM says the reply is an answer", async () => {
    const client = mockLlm(JSON.stringify({ isAnswer: true, reasoning: "The user says they could not run." }));
    const result = await isAnswerRelevantWithLlm(makeInbound({ text: "I couldn't run today" }), makePerception(), pending, client);
    expect(result.isAnswer).toBe(true);
    expect(client.complete).toHaveBeenCalledTimes(1);
  });

  it("returns false when LLM says the reply is not an answer", async () => {
    const client = mockLlm(JSON.stringify({ isAnswer: false, reasoning: "The user asks a clarifying question." }));
    const result = await isAnswerRelevantWithLlm(makeInbound({ text: "What do you mean?" }), makePerception(), pending, client);
    expect(result.isAnswer).toBe(false);
  });

  it("returns false on LLM failure / invalid JSON", async () => {
    const client = { modelName: "bad", complete: vi.fn().mockRejectedValue(new Error("timeout")) } as unknown as LLMClient;
    const result = await isAnswerRelevantWithLlm(makeInbound({ text: "whatever" }), makePerception(), pending, client);
    expect(result.isAnswer).toBe(false);
  });

  it("calls onLlmCall audit callback", async () => {
    const client = mockLlm(JSON.stringify({ isAnswer: true }));
    const onLlmCall = vi.fn();
    await isAnswerRelevantWithLlm(makeInbound({ text: "yes" }), makePerception(), pending, client, onLlmCall);
    expect(onLlmCall).toHaveBeenCalledTimes(1);
    expect(onLlmCall).toHaveBeenCalledWith("mock-relevance", expect.any(Array), expect.any(String), expect.any(Object));
  });
});

describe("looksLikeClarificationRequest", () => {
  it("returns true for clarification phrases", () => {
    expect(looksLikeClarificationRequest("What do you mean?")).toBe(true);
    expect(looksLikeClarificationRequest("I don't understand the question")).toBe(true);
    expect(looksLikeClarificationRequest("Can you explain that?")).toBe(true);
    expect(looksLikeClarificationRequest("Could you clarify?")).toBe(true);
    expect(looksLikeClarificationRequest("Say that again")).toBe(true);
  });

  it("returns false for normal answers", () => {
    expect(looksLikeClarificationRequest("none")).toBe(false);
    expect(looksLikeClarificationRequest("I woke up twice")).toBe(false);
    expect(looksLikeClarificationRequest("yes")).toBe(false);
  });
});

describe("buildClarificationMessage", () => {
  it("explains the pending question and lists options", async () => {
    const pending = {
      topic: "nighttime_symptoms",
      purpose: "Track nighttime cough or wheeze over the past 2 days.",
      expectedResponseType: "single_choice" as const,
      options: ["night_none", "night_mild", "night_disturbed", "night_woke_up"],
      askedAt: new Date().toISOString(),
    };
    const message = await buildClarificationMessage("user_1", pending, {
      style: "v1",
      locale: "en-GB",
    });
    expect(message.content.type).toBe("list");
    expect(message.content.text).toContain("Track nighttime cough or wheeze");
    const listItems = message.content.list ?? [];
    const titles = listItems.map((item) => item.title);
    expect(titles).toContain("None");
    expect(titles).toContain("Woke me up");
  });

  it("works for text questions without options", async () => {
    const pending = {
      topic: "exception_clarification",
      purpose: "Can you tell me more about what happened?",
      expectedResponseType: "text" as const,
      askedAt: new Date().toISOString(),
    };
    const message = await buildClarificationMessage("user_1", pending, {
      style: "v1",
      locale: "en-GB",
    });
    expect(message.content.type).toBe("text");
    expect(message.content.text).toContain("Can you tell me more");
    expect(message.content.text).toContain("reply in your own words");
  });
});

describe("looksLikeSkipRequest", () => {
  it("returns true for skip phrases", () => {
    expect(looksLikeSkipRequest("skip")).toBe(true);
    expect(looksLikeSkipRequest("Skip this question")).toBe(true);
    expect(looksLikeSkipRequest("Next question")).toBe(true);
    expect(looksLikeSkipRequest("I don't want to answer")).toBe(true);
    expect(looksLikeSkipRequest("I'd rather not say")).toBe(true);
    expect(looksLikeSkipRequest("pass")).toBe(true);
  });

  it("returns false for normal answers", () => {
    expect(looksLikeSkipRequest("none")).toBe(false);
    expect(looksLikeSkipRequest("I woke up twice")).toBe(false);
    expect(looksLikeSkipRequest("yes")).toBe(false);
    expect(looksLikeSkipRequest("What do you mean?")).toBe(false);
  });
});

describe("recordSkippedQuestion", () => {
  it("creates no_answer observation, clears pending, and writes user_action event", async () => {
    const pending = {
      topic: "reliever_use",
      purpose: "How often did you use your reliever?",
      expectedResponseType: "single_choice" as const,
      options: ["reliever_0", "reliever_1"],
      askedAt: new Date().toISOString(),
    };
    const observationCreate = vi.fn().mockResolvedValue(undefined);
    const checkInUpdate = vi.fn().mockResolvedValue(undefined);
    const eventCreate = vi.fn().mockResolvedValue(undefined);
    const prisma = {
      observation: { create: observationCreate },
      checkIn: { update: checkInUpdate },
      event: { create: eventCreate },
    } as unknown as import("@carememory/db").PrismaClient;

    await recordSkippedQuestion(
      prisma,
      "user_1",
      "cycle_1",
      "checkin_1",
      pending,
      "event_1",
      new Date("2026-07-11T00:00:00Z"),
      "trace_1"
    );

    expect(observationCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          userId: "user_1",
          cycleId: "cycle_1",
          eventId: "event_1",
          category: "subjective",
          concept: "reliever_use",
          value: "no_answer",
          extractedBy: "rule",
        }),
      })
    );
    expect(checkInUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "checkin_1" },
        data: expect.objectContaining({ pendingQuestion: Prisma.JsonNull, repromptCount: 0 }),
      })
    );
    expect(eventCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          userId: "user_1",
          cycleId: "cycle_1",
          checkInId: "checkin_1",
          type: "user_action",
          traceId: "trace_1",
        }),
      })
    );
  });
});
