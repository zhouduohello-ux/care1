import { describe, it, expect } from "vitest";
import { safetyCheck, applySafetyAction } from "./safety.js";
import type { OutboundMessage } from "@carememory/im-core";

function makeMessage(text: string, extra?: Partial<OutboundMessage["content"]>): OutboundMessage {
  return {
    userId: "user_1",
    conversationContext: { requiresSession: true, priority: "normal" },
    content: { type: "text", text, ...extra },
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

  it("blocks prohibited phrases inside button titles", () => {
    const result = safetyCheck(
      makeMessage("Select an option:", {
        buttons: [
          { id: "safe", title: "I feel fine" },
          { id: "unsafe", title: "You should increase your inhaler dose." },
        ],
      })
    );
    expect(result.approved).toBe(false);
    expect(result.riskLevel).toBe("high");
  });

  it("blocks prohibited phrases inside list row titles and descriptions", () => {
    const result = safetyCheck(
      makeMessage("Choose one:", {
        list: [
          { id: "a", title: "Option A", description: "Just a routine check." },
          { id: "b", title: "Option B", description: "Take 2 puffs of your reliever now." },
        ],
      })
    );
    expect(result.approved).toBe(false);
    expect(result.riskLevel).toBe("high");
  });

  it("requires medical disclaimer when asthma keywords appear only in buttons", () => {
    const result = safetyCheck(
      makeMessage("Please choose:", {
        buttons: [
          { id: "a", title: "I used my inhaler" },
          { id: "b", title: "I had wheezing" },
        ],
      })
    );
    expect(result.approved).toBe(true);
    expect(result.requiredAddendums.some((a) => a.includes("999"))).toBe(true);
  });
});

describe("applySafetyAction", () => {
  it("aborts the batch when approved is true but risk level is high", () => {
    const messages = [makeMessage("Some paraphrased unsafe advice.")];
    const summary = { approved: true, riskLevel: "high" as const, requiredAddendums: [] };

    const result = applySafetyAction(messages, summary);

    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].content.text).toBe(
      "I'm not able to answer that in a safe way. Please speak to your healthcare team if you need advice."
    );
    expect(result.summary.approved).toBe(false);
    expect(result.summary.blockReason).toMatch(/Outbound risk level high/);
  });

  it("passes through approved low-risk messages unchanged", () => {
    const messages = [makeMessage("How often did you use your inhaler?")];
    const summary = { approved: true, riskLevel: "low" as const, requiredAddendums: ["Disclaimer"] };

    const result = applySafetyAction(messages, summary);

    expect(result.messages).toEqual(messages);
    expect(result.summary).toEqual(summary);
  });
});
