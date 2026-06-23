import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  getDailyLlmLimit,
  getFallbackModel,
  isRetryableLlmError,
  getDayKey,
  hasLlmQuota,
  incrementLlmQuota,
  type QuotaStore,
} from "./llm-quota.js";

function makeMemoryStore(initial: Record<string, number> = {}): QuotaStore {
  const counts = { ...initial };
  return {
    async getDailyCount(userId: string, dayKey: string): Promise<number> {
      return counts[`${userId}:${dayKey}`] ?? 0;
    },
    async incrementDailyCount(userId: string, dayKey: string): Promise<void> {
      counts[`${userId}:${dayKey}`] = (counts[`${userId}:${dayKey}`] ?? 0) + 1;
    },
  };
}

describe("llm-quota", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("returns default daily limit", () => {
    delete process.env.LLM_DAILY_LIMIT_USER;
    expect(getDailyLlmLimit()).toBe(50);
  });

  it("reads daily limit from env", () => {
    process.env.LLM_DAILY_LIMIT_USER = "100";
    expect(getDailyLlmLimit()).toBe(100);
  });

  it("falls back to default for invalid env value", () => {
    process.env.LLM_DAILY_LIMIT_USER = "not-a-number";
    expect(getDailyLlmLimit()).toBe(50);
  });

  it("reads fallback model from env", () => {
    process.env.LLM_FALLBACK_MODEL = "gpt-4o-mini";
    expect(getFallbackModel()).toBe("gpt-4o-mini");
  });

  it("identifies rate limit errors as retryable", () => {
    expect(isRetryableLlmError(new Error("429 rate limit exceeded"))).toBe(true);
    expect(isRetryableLlmError(new Error("500 Internal Server Error"))).toBe(true);
    expect(isRetryableLlmError(new Error("invalid api key"))).toBe(false);
  });

  it("produces a local-start-of-day key", () => {
    const now = new Date("2026-06-15T14:30:00.000Z");
    expect(getDayKey(now)).toBe("2026-06-15");
  });

  it("allows LLM calls when store count is below the daily limit", async () => {
    const store = makeMemoryStore({ "user_1:2026-06-15": 49 });
    const allowed = await hasLlmQuota(store, "user_1", new Date("2026-06-15T12:00:00.000Z"));
    expect(allowed).toBe(true);
  });

  it("blocks LLM calls when store count reaches the daily limit", async () => {
    const store = makeMemoryStore({ "user_1:2026-06-15": 50 });
    const allowed = await hasLlmQuota(store, "user_1", new Date("2026-06-15T12:00:00.000Z"));
    expect(allowed).toBe(false);
  });

  it("allows LLM calls when no store is provided", async () => {
    const allowed = await hasLlmQuota(undefined, "user_1", new Date("2026-06-15T12:00:00.000Z"));
    expect(allowed).toBe(true);
  });

  it("blocks LLM calls when the daily limit is set to zero", async () => {
    process.env.LLM_DAILY_LIMIT_USER = "0";
    const store = makeMemoryStore();
    const allowed = await hasLlmQuota(store, "user_1", new Date("2026-06-15T12:00:00.000Z"));
    expect(allowed).toBe(false);
  });

  it("increments the daily counter through the store", async () => {
    process.env.LLM_DAILY_LIMIT_USER = "3";
    const store = makeMemoryStore();
    await incrementLlmQuota(store, "user_1", new Date("2026-06-15T12:00:00.000Z"));
    await incrementLlmQuota(store, "user_1", new Date("2026-06-15T14:00:00.000Z"));
    const allowed = await hasLlmQuota(store, "user_1", new Date("2026-06-15T16:00:00.000Z"));
    expect(allowed).toBe(true);
    await incrementLlmQuota(store, "user_1", new Date("2026-06-15T18:00:00.000Z"));
    const allowedAfter = await hasLlmQuota(store, "user_1", new Date("2026-06-15T20:00:00.000Z"));
    expect(allowedAfter).toBe(false);
  });

  it("does nothing when incrementing without a store", async () => {
    await expect(incrementLlmQuota(undefined, "user_1", new Date())).resolves.toBeUndefined();
  });
});
