import { describe, it, expect, vi } from "vitest";
import type { InboundMessage, OutboundMessage } from "@carememory/im-core";
import type { PerceptionResult, PlannerOutput } from "./types.js";
import {
  pendingQuestionFromPlannerOutput,
  isAnswerToPendingQuestion,
  buildRepromptMessage,
  getPendingQuestion,
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

describe("buildRepromptMessage", () => {
  it("renders a reprompt for a pending single_choice question", async () => {
    const pending = {
      topic: "activity_limitation",
      purpose: "Did asthma limit your activities?",
      expectedResponseType: "single_choice" as const,
      options: ["activity_no", "activity_yes"],
      askedAt: "",
    };
    const message = await buildRepromptMessage("user_1", pending, {});
    expect(message.content.type).toBe("buttons");
    expect(message.content.text).toContain("Did asthma limit your activities?");
    expect(message.content.buttons?.map((b) => b.id)).toEqual(["activity_no", "activity_yes"]);
  });

  it("prefixes the original purpose with a clarification", async () => {
    const pending = { topic: "severity", purpose: "Rate severity.", expectedResponseType: "text" as const, askedAt: "" };
    const message = await buildRepromptMessage("user_1", pending, {});
    expect(message.content.type).toBe("text");
    expect(message.content.text).toContain("I didn't catch that.");
    expect(message.content.text).toContain("Rate severity.");
  });
});

describe("getPendingQuestion", () => {
  it("returns pending question from latest outbound_message event payload", async () => {
    const pending = { topic: "reliever_use", purpose: "How often?", expectedResponseType: "single_choice" as const, options: ["reliever_0"], askedAt: "2026-07-11T00:00:00.000Z" };
    const prisma = {
      event: {
        findFirst: vi.fn().mockResolvedValue({
          payload: { _pendingQuestion: pending },
        }),
      },
    } as unknown as import("@carememory/db").PrismaClient;

    const result = await getPendingQuestion(prisma, "checkin_1");
    expect(result).toEqual(pending);
    expect(prisma.event.findFirst).toHaveBeenCalledWith({
      where: { checkInId: "checkin_1", type: "outbound_message" },
      orderBy: { timestamp: "desc" },
    });
  });

  it("returns undefined when no event exists", async () => {
    const prisma = {
      event: { findFirst: vi.fn().mockResolvedValue(null) },
    } as unknown as import("@carememory/db").PrismaClient;
    expect(await getPendingQuestion(prisma, "checkin_1")).toBeUndefined();
  });
});
