import { describe, it, expect } from "vitest";
import { safetyCheck } from "./safety.js";
import type { OutboundMessage } from "@carememory/im-core";

function makeMessage(text: string): OutboundMessage {
  return {
    userId: "user_1",
    conversationContext: { requiresSession: true, priority: "normal" },
    content: { type: "text", text },
  };
}

describe("safetyCheck", () => {
  it("blocks prohibited diagnostic language", () => {
    const result = safetyCheck(makeMessage("You are having an asthma attack."));
    expect(result.approved).toBe(false);
    expect(result.riskLevel).toBe("high");
  });

  it("blocks prohibited treatment advice", () => {
    const result = safetyCheck(makeMessage("You should increase your inhaler dose."));
    expect(result.approved).toBe(false);
  });

  it("blocks specific dosing instructions", () => {
    const result = safetyCheck(makeMessage("Take 2 puffs of your reliever now."));
    expect(result.approved).toBe(false);
  });

  it("requires emergency disclaimer for asthma content", () => {
    const result = safetyCheck(makeMessage("How often did you use your inhaler?"));
    expect(result.approved).toBe(true);
    expect(result.requiredAddendums.some((a) => a.includes("999"))).toBe(true);
  });

  it("requires medical disclaimer for health content", () => {
    const result = safetyCheck(makeMessage("Please tell your doctor at the visit."));
    expect(result.approved).toBe(true);
    expect(result.requiredAddendums.some((a) => a.includes("not medical advice"))).toBe(true);
  });

  it("blocks RAG-loaded prohibited phrases", () => {
    const result = safetyCheck(makeMessage("You do not need to see a doctor."));
    expect(result.approved).toBe(false);
    expect(result.riskLevel).toBe("high");
    expect(result.blockReason).toMatch(/Prohibited/);
  });

  it("approves neutral content without addendums", () => {
    const result = safetyCheck(makeMessage("Thank you for your reply."));
    expect(result.approved).toBe(true);
    expect(result.requiredAddendums).toHaveLength(0);
  });
});
