import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { InboundMessage, OutboundMessage } from "@carememory/im-core";
import type { PerceptionResult, PlannerOutput } from "./types.js";
import { Prisma } from "@carememory/db";
import type { LLMClient } from "./llm.js";
import {
  pendingQuestionFromPlannerOutput,
  isAnswerToPendingQuestion,
  evaluateAnswerToPendingQuestion,
  isAnswerRelevantWithLlm,
  buildRepromptMessage,
  buildClarificationMessage,
  looksLikeClarificationRequest,
  looksLikeUncertaintyRequest,
  buildUncertaintyProbeMessage,
  recordUncertainAnswer,
  looksLikeSkipRequest,
  recordSkippedQuestion,
  looksLikeGoBackRequest,
  goBackToPreviousQuestion,
  buildPreviousQuestionMessage,
  classifyNonAnswer,
  getTurnState,
  recordReprompt,
  clearPendingQuestion,
  setPendingQuestion,
  getMaxReprompts,
  getLlmAnswerRelevanceThreshold,
  getSessionTurnBudget,
  looksLikeSameAsBeforeRequest,
  findPreviousObservationForTopic,
  resolveSameAsBeforeValue,
  buildSameAsBeforeMessage,
  DEFAULT_MAX_REPROMPTS,
  DEFAULT_SESSION_TURN_BUDGET,
  shouldDeferOnTimeout,
  extractMultiSelectAnswers,
  detectPartialMultiSelectAnswer,
  buildPartialAnswerFollowUpMessage,
  detectTopicShift,
  buildTopicShiftAcknowledgementMessage,
  recordTopicShift,
  deferPendingQuestion,
  popDeferredQuestion,
  popNextDeferredQuestion,
  buildDeferredQuestionMessage,
  filterAnsweredDeferredQuestions,
  loadDeferredQuestionsFromPreviousCheckIn,
  levenshteinDistance,
} from "./turn-manager.js";
import { normalizeAnswerText } from "./dialogue-locales/index.js";

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

  it("accepts multi_select when all tokens match options", () => {
    const pending = { topic: "triggers", purpose: "Triggers?", expectedResponseType: "multi_select" as const, options: ["pollen", "dust", "exercise"], askedAt: "" };
    expect(isAnswerToPendingQuestion(makeInbound({ text: "pollen, dust" }), makePerception(), pending)).toBe(true);
  });

  it("rejects multi_select when no tokens match any option", () => {
    const pending = { topic: "triggers", purpose: "Triggers?", expectedResponseType: "multi_select" as const, options: ["pollen", "dust", "exercise"], askedAt: "" };
    expect(isAnswerToPendingQuestion(makeInbound({ text: "smoke and mirrors" }), makePerception(), pending)).toBe(false);
  });

  it("rejects multi_select when some tokens match but unknown meaningful words remain", () => {
    const pending = { topic: "triggers", purpose: "Triggers?", expectedResponseType: "multi_select" as const, options: ["pollen", "dust", "exercise"], askedAt: "" };
    // "smoke" is not in the option list, so this is treated as a partial answer
    // rather than a full answer.
    expect(isAnswerToPendingQuestion(makeInbound({ text: "pollen and smoke" }), makePerception(), pending, "en-GB")).toBe(false);
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

describe("evaluateAnswerToPendingQuestion", () => {
  it("scores exact button reply at 1.0", () => {
    const pending = { topic: "activity_limitation", purpose: "Limited?", expectedResponseType: "single_choice" as const, options: ["activity_no", "activity_yes"], askedAt: "" };
    const result = evaluateAnswerToPendingQuestion(makeInbound({ type: "button_reply", buttonId: "activity_yes" }), makePerception(), pending);
    expect(result.isAnswer).toBe(true);
    expect(result.confidence).toBe(1);
    expect(result.matchMethod).toBe("exact_option");
  });

  it("scores single_choice synonym match at 0.9", () => {
    const pending = { topic: "nighttime_symptoms", purpose: "Night symptoms?", expectedResponseType: "single_choice" as const, options: ["night_none", "night_mild", "night_disturbed", "night_woke_up"], askedAt: "" };
    const result = evaluateAnswerToPendingQuestion(makeInbound({ text: "woke me up" }), makePerception(), pending, "en-GB");
    expect(result.isAnswer).toBe(true);
    expect(result.confidence).toBe(0.9);
    expect(result.matchMethod).toBe("synonym");
  });

  it("scores scale number at 1.0 and scale word at 0.9", () => {
    const pending = { topic: "severity", purpose: "Rate severity.", expectedResponseType: "scale" as const, options: ["1", "2", "3", "4", "5"], askedAt: "" };
    const num = evaluateAnswerToPendingQuestion(makeInbound({ text: "3" }), makePerception(), pending);
    expect(num).toMatchObject({ isAnswer: true, confidence: 1, matchMethod: "scale_number" });
    const word = evaluateAnswerToPendingQuestion(makeInbound({ text: "severe" }), makePerception(), pending, "en-GB");
    expect(word).toMatchObject({ isAnswer: true, confidence: 0.9, matchMethod: "scale_word" });
  });

  it("scores text question with topic observation at 0.8", () => {
    const pending = { topic: "exception_clarification", purpose: "Tell me more.", expectedResponseType: "text" as const, askedAt: "" };
    const perception = makePerception({
      extractedObservations: [{ category: "subjective", concept: "exception_clarification", value: "details", confidence: 1, extractedBy: "rule" }],
    });
    const result = evaluateAnswerToPendingQuestion(makeInbound({ text: "It was bad" }), perception, pending);
    expect(result.isAnswer).toBe(true);
    expect(result.confidence).toBe(0.8);
    expect(result.matchMethod).toBe("text_observation");
  });

  it("scores text question without observation at 0.6", () => {
    const pending = { topic: "exception_clarification", purpose: "Tell me more.", expectedResponseType: "text" as const, askedAt: "" };
    const result = evaluateAnswerToPendingQuestion(makeInbound({ text: "It was bad" }), makePerception(), pending);
    expect(result.isAnswer).toBe(true);
    expect(result.confidence).toBe(0.6);
    expect(result.matchMethod).toBe("text");
  });

  it("returns zero confidence for non-answer intents", () => {
    const pending = { topic: "activity_limitation", purpose: "Limited?", expectedResponseType: "single_choice" as const, options: ["activity_no", "activity_yes"], askedAt: "" };
    const perception = makePerception({ intent: { primary: "question", confidence: 1 } });
    const result = evaluateAnswerToPendingQuestion(makeInbound({ text: "Can I skip?" }), perception, pending);
    expect(result.isAnswer).toBe(false);
    expect(result.confidence).toBe(0);
    expect(result.matchMethod).toBe("none");
  });

  it("scores partial multi_select between 0.4 and 0.9", () => {
    const pending = { topic: "triggers", purpose: "Triggers?", expectedResponseType: "multi_select" as const, options: ["pollen", "dust", "exercise"], askedAt: "" };
    const result = evaluateAnswerToPendingQuestion(makeInbound({ text: "pollen and smoke" }), makePerception(), pending, "en-GB");
    expect(result.isAnswer).toBe(false);
    expect(result.confidence).toBeGreaterThanOrEqual(0.4);
    expect(result.confidence).toBeLessThanOrEqual(0.9);
    expect(result.matchMethod).toBe("partial");
  });

  it("scores fuzzy single_choice typo match at lower confidence", () => {
    const pending = { topic: "activity_limitation", purpose: "Limited?", expectedResponseType: "single_choice" as const, options: ["activity_no", "activity_yes"], askedAt: "" };
    const result = evaluateAnswerToPendingQuestion(makeInbound({ text: "limitted" }), makePerception(), pending, "en-GB");
    expect(result.isAnswer).toBe(true);
    expect(result.matchMethod).toBe("fuzzy_synonym");
    expect(result.confidence).toBeGreaterThanOrEqual(0.75);
    expect(result.confidence).toBeLessThanOrEqual(0.9);
  });

  it("matches single_choice option id with a small typo", () => {
    const pending = { topic: "nighttime_symptoms", purpose: "Night symptoms?", expectedResponseType: "single_choice" as const, options: ["night_none", "night_mild", "night_disturbed", "night_woke_up"], askedAt: "" };
    const result = evaluateAnswerToPendingQuestion(makeInbound({ text: "night_non" }), makePerception(), pending, "en-GB");
    expect(result.isAnswer).toBe(true);
    expect(result.matchMethod).toBe("fuzzy_synonym");
  });

  it("does not fuzzy-match very short tokens to avoid false positives", () => {
    const pending = { topic: "activity_limitation", purpose: "Limited?", expectedResponseType: "single_choice" as const, options: ["activity_no", "activity_yes"], askedAt: "" };
    const result = evaluateAnswerToPendingQuestion(makeInbound({ text: "lim" }), makePerception(), pending, "en-GB");
    expect(result.isAnswer).toBe(false);
    expect(result.matchMethod).toBe("none");
  });
});

describe("levenshteinDistance", () => {
  it("returns 0 for identical strings", () => {
    expect(levenshteinDistance("mild", "mild")).toBe(0);
  });

  it("returns the number of single-character edits", () => {
    expect(levenshteinDistance("mild", "mile")).toBe(1);
    expect(levenshteinDistance("limited", "limitted")).toBe(1);
    expect(levenshteinDistance("none", "nope")).toBe(1);
  });

  it("handles empty strings", () => {
    expect(levenshteinDistance("", "abc")).toBe(3);
    expect(levenshteinDistance("abc", "")).toBe(3);
  it("matches single_choice synonym after normalization of contractions", () => {
    const pending = { topic: "reliever_use", purpose: "Reliever use?", expectedResponseType: "single_choice" as const, options: ["reliever_0", "reliever_1", "reliever_2", "reliever_3_plus"], askedAt: "" };
    const result = evaluateAnswerToPendingQuestion(makeInbound({ text: "I didn't use it" }), makePerception(), pending, "en-GB");
    expect(result.isAnswer).toBe(true);
    expect(result.matchMethod).toBe("synonym");
  });

  it("matches multi_select after normalization of punctuation and whitespace", () => {
    const pending = { topic: "triggers", purpose: "Triggers?", expectedResponseType: "multi_select" as const, options: ["pollen", "dust", "exercise"], askedAt: "" };
    const result = evaluateAnswerToPendingQuestion(makeInbound({ text: "  Pollen,  DUST!!  " }), makePerception(), pending, "en-GB");
    expect(result.isAnswer).toBe(true);
    expect(result.matchMethod).toBe("exact_option");
  });
});

describe("normalizeAnswerText", () => {
  it("trims, lowercases, and collapses whitespace", () => {
    expect(normalizeAnswerText("  Hello   World  ")).toBe("hello world");
  });

  it("expands common contractions", () => {
    expect(normalizeAnswerText("I don't know")).toBe("i do not know");
    expect(normalizeAnswerText("I didn't use it")).toBe("i did not use it");
    expect(normalizeAnswerText("can't remember")).toBe("cannot remember");
    expect(normalizeAnswerText("I'm not sure")).toBe("i am not sure");
  });

  it("strips surrounding punctuation", () => {
    expect(normalizeAnswerText("'none!'")).toBe("none");
    expect(normalizeAnswerText("...mild...")).toBe("mild");
  });

  it("preserves internal apostrophes in contractions", () => {
    expect(normalizeAnswerText("it's mild")).toBe("it is mild");
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
  it("returns pending question, reprompt count and question history from CheckIn", async () => {
    const pending = { topic: "reliever_use", purpose: "How often?", expectedResponseType: "single_choice" as const, options: ["reliever_0"], askedAt: "2026-07-11T00:00:00.000Z" };
    const history = [{ topic: "nighttime_symptoms", purpose: "Night?", expectedResponseType: "single_choice" as const, options: ["night_none"], askedAt: "2026-07-11T00:00:00.000Z" }];
    const prisma = {
      checkIn: {
        findUnique: vi.fn().mockResolvedValue({ pendingQuestion: pending, repromptCount: 1, questionHistory: history }),
      },
    } as unknown as import("@carememory/db").PrismaClient;

    const result = await getTurnState(prisma, "checkin_1");
    expect(result.pendingQuestion).toEqual(pending);
    expect(result.repromptCount).toBe(1);
    expect(result.questionHistory).toEqual(history);
    expect(prisma.checkIn.findUnique).toHaveBeenCalledWith({
      where: { id: "checkin_1" },
      select: { pendingQuestion: true, repromptCount: true, questionHistory: true },
    });
  });

  it("returns zero reprompt count and empty history when no check-in exists", async () => {
    const prisma = {
      checkIn: { findUnique: vi.fn().mockResolvedValue(null) },
    } as unknown as import("@carememory/db").PrismaClient;
    expect(await getTurnState(prisma, "checkin_1")).toEqual({ repromptCount: 0, questionHistory: [] });
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
  it("sets pending question, resets reprompt count and appends current pending to history", async () => {
    const previousPending = { topic: "nighttime_symptoms", purpose: "Night?", expectedResponseType: "single_choice" as const, options: ["night_none"], askedAt: "" };
    const pending = { topic: "reliever_use", purpose: "How often?", expectedResponseType: "single_choice" as const, options: ["reliever_0"], askedAt: "" };
    const checkInUpdate = vi.fn().mockResolvedValue(undefined);
    const prisma = {
      checkIn: {
        findUnique: vi.fn().mockResolvedValue({ pendingQuestion: previousPending, questionHistory: [] }),
        update: checkInUpdate,
      },
    } as unknown as import("@carememory/db").PrismaClient;
    await setPendingQuestion(prisma, "checkin_1", pending);
    expect(checkInUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "checkin_1" },
        data: expect.objectContaining({
          repromptCount: 0,
          pendingQuestion: pending,
          questionHistory: [previousPending],
        }),
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

  it("includes few-shot examples in the prompt", async () => {
    const client = mockLlm(JSON.stringify({ isAnswer: true, confidence: 0.85 }));
    await isAnswerRelevantWithLlm(makeInbound({ text: "I couldn't run today" }), makePerception(), pending, client);
    const messages = (client.complete as ReturnType<typeof vi.fn>).mock.calls[0][0] as Array<{ role: string; content: string }>;
    const contents = messages.map((m) => m.content).join("\n");
    expect(contents).toContain("three or four times");
    expect(contents).toContain("What do you mean by wake up?");
    expect(contents).toContain("I went running but felt a bit tight in my chest");
    expect(messages.filter((m) => m.role === "assistant").length).toBeGreaterThanOrEqual(3);
  });

  it("returns true with confidence when LLM says the reply is an answer", async () => {
    const client = mockLlm(JSON.stringify({ isAnswer: true, confidence: 0.85, reasoning: "The user says they could not run." }));
    const result = await isAnswerRelevantWithLlm(makeInbound({ text: "I couldn't run today" }), makePerception(), pending, client);
    expect(result.isAnswer).toBe(true);
    expect(result.confidence).toBe(0.85);
    expect(client.complete).toHaveBeenCalledTimes(1);
  });

  it("includes few-shot examples in the prompt", async () => {
    const client = mockLlm(JSON.stringify({ isAnswer: true, confidence: 0.85 }));
    await isAnswerRelevantWithLlm(makeInbound({ text: "I couldn't run today" }), makePerception(), pending, client);
    const messages = (client.complete as ReturnType<typeof vi.fn>).mock.calls[0][0] as Array<{ role: string; content: string }>;
    const contents = messages.map((m) => m.content).join("\n");
    expect(contents).toContain("three or four times");
    expect(contents).toContain("What do you mean by wake up?");
    expect(contents).toContain("I went running but felt a bit tight in my chest");
    expect(messages.filter((m) => m.role === "assistant").length).toBeGreaterThanOrEqual(3);
  });

  it("returns false when LLM says the reply is not an answer", async () => {
    const client = mockLlm(JSON.stringify({ isAnswer: false, confidence: 0.1, reasoning: "The user asks a clarifying question." }));
    const result = await isAnswerRelevantWithLlm(makeInbound({ text: "What do you mean?" }), makePerception(), pending, client);
    expect(result.isAnswer).toBe(false);
    expect(result.confidence).toBe(0.1);
  });

  it("returns false on LLM failure / invalid JSON", async () => {
    const client = { modelName: "bad", complete: vi.fn().mockRejectedValue(new Error("timeout")) } as unknown as LLMClient;
    const result = await isAnswerRelevantWithLlm(makeInbound({ text: "whatever" }), makePerception(), pending, client);
    expect(result.isAnswer).toBe(false);
    expect(result.confidence).toBe(0);
  });

  it("calls onLlmCall audit callback", async () => {
    const client = mockLlm(JSON.stringify({ isAnswer: true, confidence: 0.9 }));
    const onLlmCall = vi.fn();
    await isAnswerRelevantWithLlm(makeInbound({ text: "yes" }), makePerception(), pending, client, onLlmCall);
    expect(onLlmCall).toHaveBeenCalledTimes(1);
    expect(onLlmCall).toHaveBeenCalledWith("mock-relevance", expect.any(Array), expect.any(String), expect.any(Object));
  });

  it("falls back to default confidence when LLM omits confidence", async () => {
    const client = mockLlm(JSON.stringify({ isAnswer: true }));
    const result = await isAnswerRelevantWithLlm(makeInbound({ text: "yes" }), makePerception(), pending, client);
    expect(result.isAnswer).toBe(true);
    expect(result.confidence).toBe(0.7);
  });

  it("clamps out-of-range confidence values", async () => {
    const client = mockLlm(JSON.stringify({ isAnswer: true, confidence: 1.5 }));
    const high = await isAnswerRelevantWithLlm(makeInbound({ text: "yes" }), makePerception(), pending, client);
    expect(high.confidence).toBe(1);

    const clientLow = mockLlm(JSON.stringify({ isAnswer: true, confidence: -0.3 }));
    const low = await isAnswerRelevantWithLlm(makeInbound({ text: "yes" }), makePerception(), pending, clientLow);
    expect(low.confidence).toBe(0);
  });
});

describe("getLlmAnswerRelevanceThreshold", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.LLM_ANSWER_RELEVANCE_THRESHOLD;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("defaults to 0.7", () => {
    expect(getLlmAnswerRelevanceThreshold()).toBe(0.7);
  });

  it("reads from LLM_ANSWER_RELEVANCE_THRESHOLD", () => {
    process.env.LLM_ANSWER_RELEVANCE_THRESHOLD = "0.85";
    expect(getLlmAnswerRelevanceThreshold()).toBe(0.85);
  });

  it("falls back for invalid values", () => {
    process.env.LLM_ANSWER_RELEVANCE_THRESHOLD = "not-a-number";
    expect(getLlmAnswerRelevanceThreshold()).toBe(0.7);
    process.env.LLM_ANSWER_RELEVANCE_THRESHOLD = "1.5";
    expect(getLlmAnswerRelevanceThreshold()).toBe(0.7);
    process.env.LLM_ANSWER_RELEVANCE_THRESHOLD = "-0.1";
    expect(getLlmAnswerRelevanceThreshold()).toBe(0.7);
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

  it("rephrases and offers skip on the second clarification", async () => {
    const pending = {
      topic: "nighttime_symptoms",
      purpose: "Track nighttime cough or wheeze over the past 2 days.",
      expectedResponseType: "single_choice" as const,
      options: ["night_none", "night_mild", "night_disturbed", "night_woke_up"],
      askedAt: new Date().toISOString(),
      clarificationCount: 1,
    };
    const message = await buildClarificationMessage("user_1", pending, {
      style: "v1",
      locale: "en-GB",
    }, 1);
    expect(message.content.text).toContain("Let me rephrase");
    expect(message.content.text).toContain("SKIP");
  });

  it("suggests moving on after repeated clarifications", async () => {
    const pending = {
      topic: "nighttime_symptoms",
      purpose: "Track nighttime cough or wheeze over the past 2 days.",
      expectedResponseType: "single_choice" as const,
      options: ["night_none", "night_mild", "night_disturbed", "night_woke_up"],
      askedAt: new Date().toISOString(),
      clarificationCount: 2,
    };
    const message = await buildClarificationMessage("user_1", pending, {
      style: "v1",
      locale: "en-GB",
    }, 2);
    expect(message.content.text).toContain("having trouble understanding");
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

describe("looksLikeUncertaintyRequest", () => {
  it("returns true for uncertainty phrases", () => {
    expect(looksLikeUncertaintyRequest("I don't know")).toBe(true);
    expect(looksLikeUncertaintyRequest("I do not know")).toBe(true);
    expect(looksLikeUncertaintyRequest("not sure")).toBe(true);
    expect(looksLikeUncertaintyRequest("no idea")).toBe(true);
    expect(looksLikeUncertaintyRequest("can't remember")).toBe(true);
    expect(looksLikeUncertaintyRequest("cannot recall")).toBe(true);
    expect(looksLikeUncertaintyRequest("unsure")).toBe(true);
    expect(looksLikeUncertaintyRequest("idk")).toBe(true);
  });

  it("returns false for normal answers", () => {
    expect(looksLikeUncertaintyRequest("none")).toBe(false);
    expect(looksLikeUncertaintyRequest("I woke up twice")).toBe(false);
    expect(looksLikeUncertaintyRequest("skip")).toBe(false);
    expect(looksLikeUncertaintyRequest("yes")).toBe(false);
  });
});

describe("buildUncertaintyProbeMessage", () => {
  it("renders a first-time probe with the question purpose", async () => {
    const pending = {
      topic: "reliever_use",
      purpose: "How often have you used your reliever inhaler in the past week?",
      expectedResponseType: "single_choice" as const,
      options: ["reliever_0", "reliever_1"],
      askedAt: new Date().toISOString(),
    };
    const message = await buildUncertaintyProbeMessage("user_1", pending, {
      style: "v1",
      locale: "en-GB",
    }, 0);
    expect(message.content.text).toContain("if you're not sure");
    expect(message.content.text).toContain("SKIP");
  });

  it("renders a second-time probe that offers to move on", async () => {
    const pending = {
      topic: "reliever_use",
      purpose: "How often have you used your reliever inhaler in the past week?",
      expectedResponseType: "single_choice" as const,
      options: ["reliever_0", "reliever_1"],
      askedAt: new Date().toISOString(),
    };
    const message = await buildUncertaintyProbeMessage("user_1", pending, {
      style: "v1",
      locale: "en-GB",
    }, 1);
    expect(message.content.text).toContain("reply SKIP");
    expect(message.content.text).toContain("come back to this another time");
  });
});

describe("recordUncertainAnswer", () => {
  it("creates uncertain observation, clears pending, and writes user_action event", async () => {
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

    await recordUncertainAnswer(
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
          value: "uncertain",
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

describe("looksLikeGoBackRequest", () => {
  it("returns true for go-back phrases", () => {
    expect(looksLikeGoBackRequest("go back")).toBe(true);
    expect(looksLikeGoBackRequest("previous question")).toBe(true);
    expect(looksLikeGoBackRequest("last question")).toBe(true);
    expect(looksLikeGoBackRequest("back")).toBe(true);
    expect(looksLikeGoBackRequest("I want to change my answer")).toBe(true);
  });

  it("returns false for normal answers", () => {
    expect(looksLikeGoBackRequest("none")).toBe(false);
    expect(looksLikeGoBackRequest("I woke up twice")).toBe(false);
    expect(looksLikeGoBackRequest("skip")).toBe(false);
  });
});

describe("goBackToPreviousQuestion", () => {
  it("pops the last question from history and sets it as pending", async () => {
    const previousPending = { topic: "nighttime_symptoms", purpose: "Night?", expectedResponseType: "single_choice" as const, options: ["night_none"], askedAt: "" };
    const currentPending = { topic: "reliever_use", purpose: "How often?", expectedResponseType: "single_choice" as const, options: ["reliever_0"], askedAt: "" };
    const checkInUpdate = vi.fn().mockResolvedValue(undefined);
    const prisma = {
      checkIn: {
        findUnique: vi.fn().mockResolvedValue({
          pendingQuestion: currentPending,
          questionHistory: [previousPending],
        }),
        update: checkInUpdate,
      },
    } as unknown as import("@carememory/db").PrismaClient;

    const result = await goBackToPreviousQuestion(prisma, "checkin_1");
    expect(result.hasHistory).toBe(true);
    expect(result.previousQuestion).toEqual(previousPending);
    expect(checkInUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "checkin_1" },
        data: expect.objectContaining({
          pendingQuestion: previousPending,
          repromptCount: 0,
          questionHistory: [],
        }),
      })
    );
  });

  it("returns hasHistory=false when there is no history", async () => {
    const prisma = {
      checkIn: {
        findUnique: vi.fn().mockResolvedValue({ questionHistory: [] }),
        update: vi.fn().mockResolvedValue(undefined),
      },
    } as unknown as import("@carememory/db").PrismaClient;

    const result = await goBackToPreviousQuestion(prisma, "checkin_1");
    expect(result.hasHistory).toBe(false);
    expect(result.previousQuestion).toBeUndefined();
  });
});

describe("buildPreviousQuestionMessage", () => {
  it("renders the previous question", async () => {
    const pending = {
      topic: "nighttime_symptoms",
      purpose: "Track nighttime cough or wheeze over the past 2 days.",
      expectedResponseType: "single_choice" as const,
      options: ["night_none", "night_mild", "night_disturbed", "night_woke_up"],
      askedAt: new Date().toISOString(),
    };
    const message = await buildPreviousQuestionMessage("user_1", pending, {
      style: "v1",
      locale: "en-GB",
    });
    expect(message.content.type).toBe("list");
    expect(message.content.text).toContain("Going back");
    expect(message.content.text).toContain("Track nighttime cough or wheeze");
  });
});

describe("extractMultiSelectAnswers", () => {
  const pending = { topic: "triggers", purpose: "Triggers?", expectedResponseType: "multi_select" as const, options: ["pollen", "dust", "exercise"], askedAt: "" };

  it("matches option ids and ignores stop words", () => {
    const result = extractMultiSelectAnswers("I had pollen and dust", pending.options, "en-GB");
    expect(result.matched).toEqual(["pollen", "dust"]);
    expect(result.hasMeaningfulUnmatched).toBe(false);
  });

  it("matches synonyms from locale", () => {
    const result = extractMultiSelectAnswers("none and once", ["reliever_0", "reliever_1", "reliever_2"], "en-GB");
    expect(result.matched).toContain("reliever_0");
    expect(result.matched).toContain("reliever_1");
    expect(result.hasMeaningfulUnmatched).toBe(false);
  });

  it("returns unmatched meaningful tokens", () => {
    const result = extractMultiSelectAnswers("pollen and smoke", pending.options, "en-GB");
    expect(result.matched).toEqual(["pollen"]);
    expect(result.unmatched).toContain("smoke");
    expect(result.hasMeaningfulUnmatched).toBe(true);
  });

  it("returns empty when nothing matches", () => {
    const result = extractMultiSelectAnswers("smoke and mirrors", pending.options, "en-GB");
    expect(result.matched).toEqual([]);
    expect(result.hasMeaningfulUnmatched).toBe(true);
  });

  it("handles comma and 'or' separators", () => {
    const result = extractMultiSelectAnswers("pollen, dust or exercise", pending.options, "en-GB");
    expect(result.matched).toEqual(["pollen", "dust", "exercise"]);
    expect(result.hasMeaningfulUnmatched).toBe(false);
  });

  it("fuzzy-matches tokens with typos", () => {
    const result = extractMultiSelectAnswers("polen and excercise", pending.options, "en-GB");
    expect(result.matched).toEqual(["pollen", "exercise"]);
    expect(result.hasMeaningfulUnmatched).toBe(false);
  });
});

describe("detectPartialMultiSelectAnswer", () => {
  const pending = { topic: "triggers", purpose: "Triggers?", expectedResponseType: "multi_select" as const, options: ["pollen", "dust", "exercise"], askedAt: "" };

  it("detects partial answer when at least one option matches and unknown words remain", () => {
    const message = makeInbound({ text: "pollen and smoke" });
    const result = detectPartialMultiSelectAnswer(message, pending, "en-GB");
    expect(result.isPartial).toBe(true);
    expect(result.extracted.matched).toEqual(["pollen"]);
    expect(result.extracted.unmatched).toContain("smoke");
  });

  it("does not detect partial answer when all tokens match", () => {
    const message = makeInbound({ text: "pollen and dust" });
    const result = detectPartialMultiSelectAnswer(message, pending, "en-GB");
    expect(result.isPartial).toBe(false);
    expect(result.extracted.matched).toEqual(["pollen", "dust"]);
  });

  it("does not detect partial answer when nothing matches", () => {
    const message = makeInbound({ text: "smoke and mirrors" });
    const result = detectPartialMultiSelectAnswer(message, pending, "en-GB");
    expect(result.isPartial).toBe(false);
    expect(result.extracted.matched).toEqual([]);
  });
});

describe("buildPartialAnswerFollowUpMessage", () => {
  it("acknowledges matched options and asks about unmatched tokens", async () => {
    const pending = {
      topic: "triggers",
      purpose: "Have any of these triggered your asthma?",
      expectedResponseType: "multi_select" as const,
      options: ["pollen", "dust", "exercise"],
      askedAt: new Date().toISOString(),
    };
    const message = await buildPartialAnswerFollowUpMessage("user_1", pending, ["pollen"], ["smoke"], {
      style: "v1",
      locale: "en-GB",
    });
    expect(message.content.type).toBe("text");
    expect(message.content.text).toContain("Got it");
    expect(message.content.text).toContain("pollen");
    expect(message.content.text).toContain("smoke");
  });

  it("asks for more when there are no unmatched tokens", async () => {
    const pending = {
      topic: "triggers",
      purpose: "Have any of these triggered your asthma?",
      expectedResponseType: "multi_select" as const,
      options: ["pollen", "dust", "exercise"],
      askedAt: new Date().toISOString(),
    };
    const message = await buildPartialAnswerFollowUpMessage("user_1", pending, ["pollen"], [], {
      style: "v1",
      locale: "en-GB",
    });
    expect(message.content.type).toBe("text");
    expect(message.content.text).toContain("anything else");
  });
});

describe("same-as-before handling", () => {
  describe("looksLikeSameAsBeforeRequest", () => {
    it.each([
      ["same", true],
      ["Same as before", true],
      ["same as last time", true],
      ["no change", true],
      ["nothing changed", true],
      ["as before", true],
      ["reliever_1", false],
      ["I'm not sure", false],
      ["skip", false],
    ])("detects '%s' as same-as-before: %s", (text, expected) => {
      expect(looksLikeSameAsBeforeRequest(text)).toBe(expected);
    });
  });

  describe("resolveSameAsBeforeValue", () => {
    it("accepts a valid single_choice value", () => {
      const pending = {
        topic: "reliever_use",
        purpose: "How often?",
        expectedResponseType: "single_choice" as const,
        options: ["reliever_0", "reliever_1"],
        askedAt: "",
      };
      const result = resolveSameAsBeforeValue("reliever_1", pending);
      expect(result.valid).toBe(true);
      expect(result.valid ? result.normalizedValue : null).toBe("reliever_1");
    });

    it("rejects an invalid single_choice value", () => {
      const pending = {
        topic: "reliever_use",
        purpose: "How often?",
        expectedResponseType: "single_choice" as const,
        options: ["reliever_0", "reliever_1"],
        askedAt: "",
      };
      const result = resolveSameAsBeforeValue("reliever_99", pending);
      expect(result.valid).toBe(false);
    });

    it("accepts and normalizes a scale value from string", () => {
      const pending = {
        topic: "control",
        purpose: "Rate control",
        expectedResponseType: "scale" as const,
        askedAt: "",
      };
      const result = resolveSameAsBeforeValue("3", pending);
      expect(result.valid).toBe(true);
      expect(result.valid ? result.normalizedValue : null).toBe(3);
    });

    it("rejects out-of-range scale values", () => {
      const pending = {
        topic: "control",
        purpose: "Rate control",
        expectedResponseType: "scale" as const,
        askedAt: "",
      };
      expect(resolveSameAsBeforeValue("0", pending).valid).toBe(false);
      expect(resolveSameAsBeforeValue("6", pending).valid).toBe(false);
    });

    it("accepts a valid multi_select array", () => {
      const pending = {
        topic: "triggers",
        purpose: "Triggers?",
        expectedResponseType: "multi_select" as const,
        options: ["pollen", "dust", "exercise"],
        askedAt: "",
      };
      const result = resolveSameAsBeforeValue(["pollen", "exercise"], pending);
      expect(result.valid).toBe(true);
      expect(result.valid ? result.normalizedValue : null).toEqual(["pollen", "exercise"]);
    });

    it("rejects a multi_select array containing unknown options", () => {
      const pending = {
        topic: "triggers",
        purpose: "Triggers?",
        expectedResponseType: "multi_select" as const,
        options: ["pollen", "dust", "exercise"],
        askedAt: "",
      };
      const result = resolveSameAsBeforeValue(["pollen", "smoke"], pending);
      expect(result.valid).toBe(false);
    });
  });

  describe("findPreviousObservationForTopic", () => {
    it("returns the most recent non-superseded observation value", async () => {
      const findFirst = vi.fn().mockResolvedValue({ id: "obs_2", value: "reliever_1" });
      const prisma = {
        observation: { findFirst },
      } as unknown as import("@carememory/db").PrismaClient;

      const result = await findPreviousObservationForTopic(prisma, "cycle_1", "reliever_use");
      expect(result).toEqual({ observationId: "obs_2", value: "reliever_1" });
      expect(findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            cycleId: "cycle_1",
            concept: "reliever_use",
            superseded: false,
          }),
          orderBy: { timestamp: "desc" },
          select: { id: true, value: true },
        })
      );
    });

    it("returns undefined when no previous observation exists", async () => {
      const prisma = {
        observation: { findFirst: vi.fn().mockResolvedValue(null) },
      } as unknown as import("@carememory/db").PrismaClient;

      const result = await findPreviousObservationForTopic(prisma, "cycle_1", "reliever_use");
      expect(result).toBeUndefined();
    });
  });

  describe("buildSameAsBeforeMessage", () => {
    it("renders an inform message acknowledging reuse of the previous answer", async () => {
      const pending = {
        topic: "reliever_use",
        purpose: "How often did you use your reliever inhaler?",
        expectedResponseType: "single_choice" as const,
        options: ["reliever_0", "reliever_1"],
        askedAt: "",
      };
      const message = await buildSameAsBeforeMessage("user_1", pending, { style: "v1", locale: "en-GB" });
      expect(message.content.type).toBe("text");
      expect(message.content.text).toContain("carry over");
      expect(message.content.text).toContain("How often did you use your reliever inhaler");
    });
  });
});

describe("getSessionTurnBudget", () => {
  const originalEnv = process.env.SESSION_TURN_BUDGET;

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.SESSION_TURN_BUDGET;
    } else {
      process.env.SESSION_TURN_BUDGET = originalEnv;
    }
  });

  it("returns the default session turn budget", () => {
    delete process.env.SESSION_TURN_BUDGET;
    expect(getSessionTurnBudget()).toBe(DEFAULT_SESSION_TURN_BUDGET);
  });

  it("reads SESSION_TURN_BUDGET from environment", () => {
    process.env.SESSION_TURN_BUDGET = "8";
    expect(getSessionTurnBudget()).toBe(8);
  });

  it("falls back to default for invalid values", () => {
    process.env.SESSION_TURN_BUDGET = "not-a-number";
    expect(getSessionTurnBudget()).toBe(DEFAULT_SESSION_TURN_BUDGET);
    process.env.SESSION_TURN_BUDGET = "-1";
    expect(getSessionTurnBudget()).toBe(DEFAULT_SESSION_TURN_BUDGET);
    process.env.SESSION_TURN_BUDGET = "1.5";
    expect(getSessionTurnBudget()).toBe(DEFAULT_SESSION_TURN_BUDGET);
  });
});

describe("shouldDeferOnTimeout", () => {
  const originalEnv = process.env.PENDING_QUESTION_TIMEOUT_DEFERS;

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.PENDING_QUESTION_TIMEOUT_DEFERS;
    } else {
      process.env.PENDING_QUESTION_TIMEOUT_DEFERS = originalEnv;
    }
  });

  it("defaults to true", () => {
    delete process.env.PENDING_QUESTION_TIMEOUT_DEFERS;
    expect(shouldDeferOnTimeout()).toBe(true);
  });

  it("reads PENDING_QUESTION_TIMEOUT_DEFERS from environment", () => {
    process.env.PENDING_QUESTION_TIMEOUT_DEFERS = "false";
    expect(shouldDeferOnTimeout()).toBe(false);
    process.env.PENDING_QUESTION_TIMEOUT_DEFERS = "0";
    expect(shouldDeferOnTimeout()).toBe(false);
    process.env.PENDING_QUESTION_TIMEOUT_DEFERS = "true";
    expect(shouldDeferOnTimeout()).toBe(true);
    process.env.PENDING_QUESTION_TIMEOUT_DEFERS = "1";
    expect(shouldDeferOnTimeout()).toBe(true);
  });

  it("falls back to default for invalid values", () => {
    process.env.PENDING_QUESTION_TIMEOUT_DEFERS = "maybe";
    expect(shouldDeferOnTimeout()).toBe(true);
  });
});

describe("detectTopicShift", () => {
  const pending = { topic: "reliever_use", purpose: "How often?", expectedResponseType: "single_choice" as const, options: ["reliever_0", "reliever_1"], askedAt: "" };

  it("returns false when the reply answers the pending question", () => {
    const perception = makePerception({
      extractedObservations: [{ category: "medication", concept: "reliever_use", value: "reliever_1", confidence: 1, extractedBy: "rule" }],
    });
    const evaluation = evaluateAnswerToPendingQuestion(makeInbound({ text: "once" }), perception, pending, "en-GB");
    const result = detectTopicShift(perception, pending, evaluation);
    expect(result.isTopicShift).toBe(false);
    expect(result.shiftedObservations).toEqual([]);
  });

  it("returns false for non-answer intents", () => {
    const perception = makePerception({
      intent: { primary: "question", confidence: 1 },
      extractedObservations: [{ category: "subjective", concept: "trigger", value: "pollen", confidence: 1, extractedBy: "rule" }],
    });
    const evaluation = evaluateAnswerToPendingQuestion(makeInbound({ text: "What do you mean?" }), perception, pending);
    const result = detectTopicShift(perception, pending, evaluation);
    expect(result.isTopicShift).toBe(false);
  });

  it("does not treat vague uncertainty as a topic shift", () => {
    const perception = makePerception({
      extractedObservations: [{ category: "subjective", concept: "uncertainty", value: "not sure", confidence: 1, extractedBy: "rule" }],
    });
    const evaluation = evaluateAnswerToPendingQuestion(makeInbound({ text: "not sure" }), perception, pending, "en-GB");
    const result = detectTopicShift(perception, pending, evaluation);
    expect(result.isTopicShift).toBe(false);
  });

  it("detects a shift when the user introduces a different observation", () => {
    const perception = makePerception({
      extractedObservations: [{ category: "symptom", concept: "nighttime_symptoms", value: "yes", confidence: 1, extractedBy: "rule" }],
    });
    const evaluation = evaluateAnswerToPendingQuestion(makeInbound({ text: "I wheezed last night" }), perception, pending, "en-GB");
    const result = detectTopicShift(perception, pending, evaluation);
    expect(result.isTopicShift).toBe(true);
    expect(result.shiftedObservations).toHaveLength(1);
    expect(result.shiftedObservations[0].concept).toBe("nighttime_symptoms");
  });
});

describe("buildTopicShiftAcknowledgementMessage", () => {
  it("acknowledges the shifted concepts and moves on", async () => {
    const pending = { topic: "reliever_use", purpose: "How often?", expectedResponseType: "single_choice" as const, options: ["reliever_0"], askedAt: "" };
    const shifted = [{ category: "symptom" as const, concept: "nighttime_symptoms", value: "yes", confidence: 1, extractedBy: "rule" as const }];
    const message = await buildTopicShiftAcknowledgementMessage("user_1", pending, shifted, { style: "v1", locale: "en-GB" });
    expect(message.content.type).toBe("text");
    expect(message.content.text).toContain("nighttime symptoms");
    expect(message.content.text).toContain("move on");
  });
});

describe("recordTopicShift", () => {
  it("records no_answer for the pending question, clears pending, and writes a user_action event", async () => {
    const pending = { topic: "reliever_use", purpose: "How often?", expectedResponseType: "single_choice" as const, options: ["reliever_0"], askedAt: "" };
    const observationCreate = vi.fn().mockResolvedValue(undefined);
    const checkInUpdate = vi.fn().mockResolvedValue(undefined);
    const eventCreate = vi.fn().mockResolvedValue(undefined);
    const prisma = {
      observation: { create: observationCreate },
      checkIn: { update: checkInUpdate },
      event: { create: eventCreate },
    } as unknown as import("@carememory/db").PrismaClient;

    await recordTopicShift(
      prisma,
      "user_1",
      "cycle_1",
      "checkin_1",
      pending,
      [{ category: "symptom" as const, concept: "nighttime_symptoms", value: "yes", confidence: 1, extractedBy: "rule" as const }],
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
          attributes: { reason: "topic_shift" },
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
  const pending = { topic: "reliever_use", purpose: "Reliever use?", expectedResponseType: "single_choice" as const, options: ["reliever_0", "reliever_1"], askedAt: "" };

  it("returns false when the user answers the pending topic", () => {
    const perception = makePerception({
      extractedObservations: [{ category: "medication", concept: "reliever_use", value: "reliever_1", confidence: 1, extractedBy: "rule" }],
    });
    const result = detectTopicShift(makeInbound({ text: "once" }), perception, pending);
    expect(result.isShift).toBe(false);
  });

  it("returns true when the user provides an observation for a different topic", () => {
    const perception = makePerception({
      extractedObservations: [{ category: "symptom", concept: "nighttime_symptoms", value: "night_mild", confidence: 1, extractedBy: "rule" }],
    });
    const result = detectTopicShift(makeInbound({ text: "I had a mild cough at night" }), perception, pending);
    expect(result.isShift).toBe(true);
    expect(result.shiftedToTopic).toBe("nighttime_symptoms");
    expect(result.shiftedToObservations).toHaveLength(1);
  });

  it("returns false for system-command intents such as skip or help", () => {
    const perception = makePerception({
      intent: { primary: "help", confidence: 1 },
      extractedObservations: [{ category: "symptom", concept: "nighttime_symptoms", value: "night_mild", confidence: 1, extractedBy: "rule" }],
    });
    const result = detectTopicShift(makeInbound({ text: "help" }), perception, pending);
    expect(result.isShift).toBe(false);
  });

  it("returns false when no observations are extracted", () => {
    const perception = makePerception({ rawText: "something random" });
    const result = detectTopicShift(makeInbound({ text: "something random" }), perception, pending);
    expect(result.isShift).toBe(false);
  });
});

describe("deferPendingQuestion", () => {
  it("appends the pending question to deferredQuestions and clears pending", async () => {
    const pending = { topic: "reliever_use", purpose: "Reliever use?", expectedResponseType: "single_choice" as const, options: ["reliever_0"], askedAt: "" };
    const checkInUpdate = vi.fn().mockResolvedValue(undefined);
    const prisma = {
      checkIn: {
        findUnique: vi.fn().mockResolvedValue({ deferredQuestions: [] }),
        update: checkInUpdate,
      },
    } as unknown as import("@carememory/db").PrismaClient;

    const result = await deferPendingQuestion(prisma, "checkin_1", pending);
    expect(result).toHaveLength(1);
    expect(result[0].topic).toBe("reliever_use");
    expect(result[0].deferredAt).toBeDefined();
    expect(checkInUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "checkin_1" },
        data: expect.objectContaining({
          pendingQuestion: Prisma.JsonNull,
          repromptCount: 0,
        }),
      })
    );
  });
});

describe("popDeferredQuestion", () => {
  it("returns undefined when there are no deferred questions", async () => {
    const prisma = {
      checkIn: {
        findUnique: vi.fn().mockResolvedValue({ deferredQuestions: [] }),
        update: vi.fn().mockResolvedValue(undefined),
      },
    } as unknown as import("@carememory/db").PrismaClient;

    const result = await popDeferredQuestion(prisma, "checkin_1");
    expect(result).toBeUndefined();
  });

  it("pops the oldest deferred question and sets it as pending", async () => {
    const deferred = [
      { topic: "reliever_use", purpose: "Reliever use?", expectedResponseType: "single_choice" as const, options: ["reliever_0"], askedAt: "", deferredAt: "2026-01-01T00:00:00.000Z" },
      { topic: "activity_limitation", purpose: "Limited?", expectedResponseType: "single_choice" as const, options: ["activity_no"], askedAt: "", deferredAt: "2026-01-01T00:00:01.000Z" },
    ];
    const checkInUpdate = vi.fn().mockResolvedValue(undefined);
    const prisma = {
      checkIn: {
        findUnique: vi.fn().mockResolvedValue({ deferredQuestions: deferred }),
        update: checkInUpdate,
      },
    } as unknown as import("@carememory/db").PrismaClient;

    const result = await popDeferredQuestion(prisma, "checkin_1");
    expect(result?.topic).toBe("reliever_use");
    expect(checkInUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "checkin_1" },
        data: expect.objectContaining({
          pendingQuestion: deferred[0],
          deferredQuestions: [deferred[1]],
          repromptCount: 0,
        }),
      })
    );
  });
});

describe("buildDeferredQuestionMessage", () => {
  it("renders a deferred question with a 'Before we finish' prefix", async () => {
    const pending = {
      topic: "reliever_use",
      purpose: "How often did you use your reliever?",
      expectedResponseType: "single_choice" as const,
      options: ["reliever_0", "reliever_1"],
      askedAt: "",
    };
    const message = await buildDeferredQuestionMessage("user_1", pending, { style: "v1", locale: "en-GB" });
    expect(message.content.type).toBe("buttons");
    expect(message.content.text).toContain("Before we finish");
    expect(message.content.text).toContain(pending.purpose);
  });
});

describe("filterAnsweredDeferredQuestions", () => {
  it("removes deferred questions whose topic already has a recent observation", () => {
    const deferred = [
      { topic: "reliever_use", purpose: "Reliever?", expectedResponseType: "single_choice" as const, options: ["reliever_0"], askedAt: "", deferredAt: "2026-01-01T00:00:00.000Z" },
      { topic: "activity_limitation", purpose: "Activity?", expectedResponseType: "single_choice" as const, options: ["activity_no"], askedAt: "", deferredAt: "2026-01-01T00:00:01.000Z" },
    ];
    const observations = [{ concept: "reliever_use" }];
    const result = filterAnsweredDeferredQuestions(deferred, observations);
    expect(result).toHaveLength(1);
    expect(result[0].topic).toBe("activity_limitation");
  });

  it("returns all deferred questions when none are answered", () => {
    const deferred = [
      { topic: "reliever_use", purpose: "Reliever?", expectedResponseType: "single_choice" as const, options: ["reliever_0"], askedAt: "", deferredAt: "2026-01-01T00:00:00.000Z" },
    ];
    const result = filterAnsweredDeferredQuestions(deferred, []);
    expect(result).toHaveLength(1);
  });
});

describe("loadDeferredQuestionsFromPreviousCheckIn", () => {
  it("loads deferred questions from the most recent check-in in the cycle", async () => {
    const deferred = [
      { topic: "reliever_use", purpose: "Reliever?", expectedResponseType: "single_choice" as const, options: ["reliever_0"], askedAt: "", deferredAt: "2026-01-01T00:00:00.000Z" },
    ];
    const prisma = {
      checkIn: {
        findFirst: vi.fn().mockResolvedValue({ deferredQuestions: deferred }),
      },
    } as unknown as import("@carememory/db").PrismaClient;

    const result = await loadDeferredQuestionsFromPreviousCheckIn(prisma, "cycle_1", "checkin_2");
    expect(result).toHaveLength(1);
    expect(result[0].topic).toBe("reliever_use");
  });
});

describe("popNextDeferredQuestion", () => {
  it("pops the oldest unanswered deferred question", async () => {
    const deferred = [
      { topic: "reliever_use", purpose: "Reliever?", expectedResponseType: "single_choice" as const, options: ["reliever_0"], askedAt: "", deferredAt: "2026-01-01T00:00:00.000Z" },
      { topic: "activity_limitation", purpose: "Activity?", expectedResponseType: "single_choice" as const, options: ["activity_no"], askedAt: "", deferredAt: "2026-01-01T00:00:01.000Z" },
    ];
    const checkInUpdate = vi.fn().mockResolvedValue(undefined);
    const prisma = {
      checkIn: {
        findUnique: vi.fn().mockResolvedValue({ deferredQuestions: deferred }),
        update: checkInUpdate,
      },
    } as unknown as import("@carememory/db").PrismaClient;

    const result = await popNextDeferredQuestion(prisma, "checkin_1", [{ concept: "reliever_use" }]);
    expect(result?.topic).toBe("activity_limitation");
    expect(checkInUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "checkin_1" },
        data: expect.objectContaining({
          pendingQuestion: deferred[1],
          deferredQuestions: Prisma.JsonNull,
          repromptCount: 0,
        }),
      })
    );
  });

  it("returns undefined when all deferred questions are already answered", async () => {
    const deferred = [
      { topic: "reliever_use", purpose: "Reliever?", expectedResponseType: "single_choice" as const, options: ["reliever_0"], askedAt: "", deferredAt: "2026-01-01T00:00:00.000Z" },
    ];
    const checkInUpdate = vi.fn().mockResolvedValue(undefined);
    const prisma = {
      checkIn: {
        findUnique: vi.fn().mockResolvedValue({ deferredQuestions: deferred }),
        update: checkInUpdate,
      },
    } as unknown as import("@carememory/db").PrismaClient;

    const result = await popNextDeferredQuestion(prisma, "checkin_1", [{ concept: "reliever_use" }]);
    expect(result).toBeUndefined();
    expect(checkInUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "checkin_1" },
        data: expect.objectContaining({
          deferredQuestions: Prisma.JsonNull,
        }),
      })
    );
  });
});
