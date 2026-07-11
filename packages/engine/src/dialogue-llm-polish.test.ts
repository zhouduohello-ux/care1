import { describe, it, expect, vi, beforeEach } from "vitest";
import { polishMessage, resetPolishCache } from "./dialogue-llm-polish.js";
import type { LLMClient } from "./llm.js";

function mockLlm(polishedText: string): LLMClient {
  return {
    modelName: "mock-polish",
    complete: vi.fn().mockResolvedValue({
      content: polishedText,
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
    }),
  };
}

describe("polishMessage", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetPolishCache();
  });

  it("returns LLM output when no cache hit", async () => {
    const llmClient = mockLlm("Polished result.");
    const result = await polishMessage("Hello.", { llmClient });

    expect(result).toBe("Polished result.");
    expect(llmClient.complete).toHaveBeenCalledTimes(1);
  });

  it("caches result and skips LLM on identical input", async () => {
    const llmClient = mockLlm("Polished result.");
    await polishMessage("Hello.", { llmClient, intent: "inform" });
    const result = await polishMessage("Hello.", { llmClient, intent: "inform" });

    expect(result).toBe("Polished result.");
    expect(llmClient.complete).toHaveBeenCalledTimes(1);
  });

  it("does not share cache across intent or locale", async () => {
    const llmClient = mockLlm("Polished result.");
    await polishMessage("Hello.", { llmClient, intent: "inform" });
    await polishMessage("Hello.", { llmClient, intent: "closing" });

    expect(llmClient.complete).toHaveBeenCalledTimes(2);
  });

  it("expires cache after TTL", async () => {
    const llmClient = mockLlm("Polished result.");
    await polishMessage("Hello.", { llmClient });
    vi.advanceTimersByTime(5 * 60 * 1000 + 1);
    await polishMessage("Hello.", { llmClient });

    expect(llmClient.complete).toHaveBeenCalledTimes(2);
  });

  it("truncates LLM output to hard cap", async () => {
    const longText = "a".repeat(500);
    const llmClient = mockLlm(longText);
    const result = await polishMessage("Hello.", { llmClient });

    expect(result.length).toBe(320);
    expect(result.endsWith("…")).toBe(true);
  });

  it("invokes audit callback when provided", async () => {
    const llmClient = mockLlm("Polished result.");
    const onLlmCall = vi.fn();
    await polishMessage("Hello.", { llmClient, onLlmCall });

    expect(onLlmCall).toHaveBeenCalledTimes(1);
    expect(onLlmCall).toHaveBeenCalledWith(
      "mock-polish",
      expect.any(Array),
      "Polished result.",
      { promptTokens: 10, completionTokens: 5, totalTokens: 15 }
    );
  });
});
