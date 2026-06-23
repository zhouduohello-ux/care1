import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createOpenAIClient, createStubClient } from "./llm.js";
import { perceive } from "./perception.js";
import { plan } from "./planner.js";
import type { InboundMessage } from "@carememory/im-core";

describe("LLM client", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ choices: [{ message: { content: "Hello" } }] }),
      })
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("calls OpenAI chat completions endpoint", async () => {
    const client = createOpenAIClient({ apiKey: "sk-test" });
    const response = await client.complete([{ role: "user", content: "Hi" }]);
    expect(response).toBe("Hello");
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe("https://api.openai.com/v1/chat/completions");
    expect(init.headers).toMatchObject({ Authorization: "Bearer sk-test" });
  });

  it("throws on API error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        text: async () => "Rate limited",
      })
    );
    const client = createOpenAIClient({ apiKey: "sk-test" });
    await expect(client.complete([{ role: "user", content: "Hi" }])).rejects.toThrow("Rate limited");
  });

  it("stub client returns fixed response", async () => {
    const client = createStubClient('{"intent":{"primary":"answer"}}');
    const response = await client.complete([]);
    expect(response).toBe('{"intent":{"primary":"answer"}}');
  });

  it("perceive uses LLM for free text when provided", async () => {
    const message: InboundMessage = {
      platform: "test",
      channelId: "user_1",
      messageId: "msg_1",
      timestamp: new Date(),
      content: {
        type: "text",
        text: "I woke up twice last night wheezing",
        rawPayload: {},
      },
    };

    const client = createStubClient(
      JSON.stringify({
        intent: { primary: "answer", confidence: 0.9 },
        extractedObservations: [
          { category: "symptom", concept: "nighttime_symptoms", value: "woke_me_up" },
        ],
        anomalies: [],
        safetyFlags: [],
      })
    );

    const result = await perceive(message, client);
    expect(result.intent.primary).toBe("answer");
    expect(result.extractedObservations[0]).toMatchObject({
      category: "symptom",
      concept: "nighttime_symptoms",
      value: "woke_me_up",
      extractedBy: "llm",
    });
  });

  it("planner uses LLM when provided", async () => {
    const client = createStubClient(
      JSON.stringify({
        reasoning: "LLM reasoning",
        sessionObjective: "Track control",
        nextAction: {
          type: "ask",
          topic: "nighttime_symptoms",
          purpose: "How was your night?",
          expectedResponseType: "single_choice",
          options: ["night_none", "night_mild", "night_disturbed", "night_woke_up"],
          budgetCost: 1,
        },
        safetyFlag: "none",
        updatePatientState: {},
      })
    );

    const output = await plan(
      {
        patientContext: {
          disease: "asthma",
          cycleId: "c1",
          cycleDay: 1,
          narrativeSummary: "",
          recentObservations: [],
          openIssues: [],
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
      },
      client
    );

    expect(output.nextAction.topic).toBe("nighttime_symptoms");
    expect(output.reasoning).toBe("LLM reasoning");
  });

  it("perceive falls back to rules when LLM fails", async () => {
    const message: InboundMessage = {
      platform: "test",
      channelId: "user_1",
      messageId: "msg_1",
      timestamp: new Date(),
      content: { type: "text", text: "fine", rawPayload: {} },
    };

    const client = createOpenAIClient({ apiKey: "sk-test" });
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Network error")));

    const result = await perceive(message, client);
    expect(result.extractedObservations[0]).toMatchObject({
      category: "subjective",
      concept: "free_text_response",
      extractedBy: "rule",
    });
  });
});
