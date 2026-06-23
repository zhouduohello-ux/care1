import { describe, it, expect } from "vitest";
import { perceive } from "./perception.js";
import type { InboundMessage } from "@carememory/im-core";

function makeMessage(text: string, buttonId?: string): InboundMessage {
  return {
    platform: "test",
    channelId: "user_123",
    messageId: "msg_1",
    timestamp: new Date(),
    content: {
      type: buttonId ? "button_reply" : "text",
      text,
      buttonId,
      rawPayload: {},
    },
  };
}

describe("perceive", () => {
  it("detects START ASTHMA", async () => {
    const result = await perceive(makeMessage("start asthma"));
    expect(result.intent.primary).toBe("initiate");
    expect(result.extractedObservations[0].concept).toBe("start_asthma");
  });

  it("detects AGREE consent", async () => {
    const result = await perceive(makeMessage("agree"));
    expect(result.intent.primary).toBe("consent");
    expect(result.extractedObservations[0].concept).toBe("consent_given");
  });

  it("detects STOP", async () => {
    const result = await perceive(makeMessage("stop"));
    expect(result.intent.primary).toBe("stop");
  });

  it("detects DELETE MY DATA", async () => {
    const result = await perceive(makeMessage("delete my data"));
    expect(result.intent.primary).toBe("delete_data");
  });

  it("detects EXPORT MY DATA", async () => {
    const result = await perceive(makeMessage("export my data"));
    expect(result.intent.primary).toBe("export_data");
  });

  it("detects HELP", async () => {
    const result = await perceive(makeMessage("help"));
    expect(result.intent.primary).toBe("help");
  });

  it("is case-insensitive for system commands", async () => {
    const result = await perceive(makeMessage("  Export My Data  "));
    expect(result.intent.primary).toBe("export_data");
  });

  it("maps button replies to observations", async () => {
    const result = await perceive(makeMessage("Mild", "night_mild"));
    expect(result.intent.primary).toBe("answer");
    expect(result.extractedObservations[0]).toMatchObject({
      category: "symptom",
      concept: "nighttime_symptoms",
      value: "mild",
    });
  });

  it("flags severe symptom language", async () => {
    const result = await perceive(makeMessage("I cannot breathe, please call 999"));
    expect(result.safetyFlags.some((f) => f.riskLevel === "high")).toBe(true);
  });

  it("flags possible adverse events", async () => {
    const result = await perceive(makeMessage("I have a rash and swelling"));
    expect(result.anomalies.some((a) => a.type === "possible_adverse_event")).toBe(true);
  });

  it("falls back to free text observation", async () => {
    const result = await perceive(makeMessage("feeling fine today"));
    expect(result.extractedObservations[0]).toMatchObject({
      category: "subjective",
      concept: "free_text_response",
      value: "feeling fine today",
    });
  });

  it("detects correction intent", async () => {
    const result = await perceive(makeMessage("I was wrong, I actually used my reliever 3 times"));
    expect(result.intent.primary).toBe("correction");
  });

  it("detects CONTINUE cycle command", async () => {
    const result = await perceive(makeMessage("continue"));
    expect(result.intent.primary).toBe("continue_cycle");
  });

  it("detects confirmation to add update to recent record", async () => {
    const result = await perceive(makeMessage("yes"));
    expect(result.intent.primary).toBe("confirm_recent_context");
  });

  it("detects explicit add-to-last-record command", async () => {
    const result = await perceive(makeMessage("Add to last record"));
    expect(result.intent.primary).toBe("confirm_recent_context");
  });
});
