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
    const client = createOpenAIClient({ apiKey: "sk-test", baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini" });
    const { content } = await client.complete([{ role: "user", content: "Hi" }]);
    expect(content).toBe("Hello");
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
    const client = createOpenAIClient({ apiKey: "sk-test", baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini" });
    await expect(client.complete([{ role: "user", content: "Hi" }])).rejects.toThrow("Rate limited");
  });

  it("stub client returns fixed response", async () => {
    const client = createStubClient('{"intent":{"primary":"answer"}}');
    const { content } = await client.complete([]);
    expect(content).toBe('{"intent":{"primary":"answer"}}');
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
    expect(output.reasoning).toBe("LLM reasoning (guardrail: enforced question-bank order)");
  });

  it("perceive falls back to rules when LLM fails", async () => {
    const message: InboundMessage = {
      platform: "test",
      channelId: "user_1",
      messageId: "msg_1",
      timestamp: new Date(),
      content: { type: "text", text: "fine", rawPayload: {} },
    };

    const client = createOpenAIClient({ apiKey: "sk-test", baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini" });
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Network error")));

    const result = await perceive(message, client);
    expect(result.extractedObservations[0]).toMatchObject({
      category: "subjective",
      concept: "free_text_response",
      extractedBy: "rule",
    });
  });

  it("retries retryable errors with exponential backoff", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error("fetch failed"))
      .mockRejectedValueOnce(new Error("503 Service Unavailable"))
      .mockResolvedValue({
        ok: true,
        json: async () => ({ choices: [{ message: { content: "Hello" } }] }),
      });
    vi.stubGlobal("fetch", fetchMock);

    const client = createOpenAIClient({
      apiKey: "sk-test",
      baseUrl: "https://api.openai.com/v1",
      model: "gpt-4o-mini",
      maxRetries: 2,
      retryBaseDelayMs: 10,
    });

    const { content } = await client.complete([{ role: "user", content: "Hi" }]);
    expect(content).toBe("Hello");
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("falls back to fallback model after primary retries are exhausted", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error("429 Rate limited"))
      .mockRejectedValueOnce(new Error("429 Rate limited"))
      .mockResolvedValue({
        ok: true,
        json: async () => ({ choices: [{ message: { content: "Hello from fallback" } }] }),
      });
    vi.stubGlobal("fetch", fetchMock);

    const client = createOpenAIClient({
      apiKey: "sk-test",
      baseUrl: "https://api.openai.com/v1",
      model: "gpt-4o-mini",
      fallbackModel: "fallback-model",
      maxRetries: 1,
      retryBaseDelayMs: 10,
    });

    const { content } = await client.complete([{ role: "user", content: "Hi" }]);
    expect(content).toBe("Hello from fallback");
    const lastCallBody = JSON.parse(fetchMock.mock.calls[fetchMock.mock.calls.length - 1][1].body);
    expect(lastCallBody.model).toBe("fallback-model");
  });

  it("throws LlmTimeoutError when request exceeds timeout", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((_url: string, init?: RequestInit) => {
        return new Promise((_resolve, reject) => {
          const timer = setTimeout(() => reject(new Error("should not reach")), 1000);
          if (init?.signal) {
            init.signal.addEventListener("abort", () => {
              clearTimeout(timer);
              const abortError = new Error("AbortError");
              abortError.name = "AbortError";
              reject(abortError);
            });
          }
        });
      })
    );

    const client = createOpenAIClient({
      apiKey: "sk-test",
      baseUrl: "https://api.openai.com/v1",
      model: "gpt-4o-mini",
      timeoutMs: 50,
      maxRetries: 0,
    });

    await expect(client.complete([{ role: "user", content: "Hi" }])).rejects.toThrow("timed out");
  });
});
