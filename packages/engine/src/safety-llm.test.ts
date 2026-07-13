import { describe, it, expect } from "vitest";
import { llmSafetyCheckAsync, type LlmSafetyCheckInput } from "./safety-llm.js";
import { createStubClient } from "./llm.js";
import type { OutboundMessage } from "@carememory/im-core";

function makeMessage(text: string, extra?: Partial<OutboundMessage["content"]>): OutboundMessage {
  return {
    userId: "user_1",
    conversationContext: { requiresSession: true, priority: "normal" },
    content: { type: "text", text, ...extra },
  };
}

const DEFAULT_INPUT: LlmSafetyCheckInput = {
  messages: [makeMessage("How often did you use your reliever?")],
  disease: "asthma",
  rules: {
    prohibitedPhrases: ["You do not need to see a doctor."],
    requiredAddendums: ["This is based on patient-reported information only and is not medical advice."],
    escalationTriggers: ["severe"],
  },
};

describe("llmSafetyCheckAsync", () => {
  it("approves safe questions", async () => {
    const client = createStubClient(JSON.stringify({ approved: true, riskLevel: "none" }));
    const result = await llmSafetyCheckAsync(DEFAULT_INPUT, client);
    expect(result.approved).toBe(true);
    expect(result.riskLevel).toBe("none");
  });

  it("blocks unsafe paraphrased advice", async () => {
    const client = createStubClient(
      JSON.stringify({ approved: false, riskLevel: "high", blockReason: "Gives treatment advice" })
    );
    const result = await llmSafetyCheckAsync(DEFAULT_INPUT, client);
    expect(result.approved).toBe(false);
    expect(result.riskLevel).toBe("high");
    expect(result.blockReason).toMatch(/treatment advice/i);
  });

  it("treats non-JSON response as unsafe", async () => {
    const client = createStubClient("I cannot decide");
    const result = await llmSafetyCheckAsync(DEFAULT_INPUT, client);
    expect(result.approved).toBe(false);
    expect(result.riskLevel).toBe("high");
  });

  it("treats missing riskLevel as high", async () => {
    const client = createStubClient(JSON.stringify({ approved: true }));
    const result = await llmSafetyCheckAsync(DEFAULT_INPUT, client);
    expect(result.approved).toBe(true);
    expect(result.riskLevel).toBe("high");
  });
});
