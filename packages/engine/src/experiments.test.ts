import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { getBucket, scheduleNextCheckInOffset, getSafetyClassifierVariant, isLlmSafetyClassifierEnabled } from "./experiments.js";

describe("experiments", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("returns default variant when experiment is disabled", () => {
    process.env.EXPERIMENT_CHECKIN_FREQUENCY_ENABLED = "false";
    const bucket = getBucket("user_123", "checkin_frequency");
    expect(bucket.variant).toBe("48h");
  });

  it("returns a valid variant when experiment is enabled", () => {
    process.env.EXPERIMENT_CHECKIN_FREQUENCY_ENABLED = "true";
    const bucket = getBucket("user_123", "checkin_frequency");
    expect(["48h", "72h"]).toContain(bucket.variant);
  });

  it("distributes users across variants roughly according to split", () => {
    process.env.EXPERIMENT_CHECKIN_FREQUENCY_ENABLED = "true";
    process.env.EXPERIMENT_CHECKIN_FREQUENCY_SPLIT = "80,20";
    const counts = { "48h": 0, "72h": 0 };
    for (let i = 0; i < 100; i++) {
      const bucket = getBucket(`user_${i}`, "checkin_frequency");
      counts[bucket.variant as "48h" | "72h"]++;
    }
    expect(counts["48h"]).toBeGreaterThan(50);
    expect(counts["72h"]).toBeGreaterThan(0);
  });

  it("schedules next check-in at 10:00 local time", () => {
    const now = new Date("2026-06-15T14:30:00Z");
    const next = scheduleNextCheckInOffset("user_123", now);
    expect(next.getHours()).toBe(10);
    expect(next.getMinutes()).toBe(0);
    expect(next.getTime()).toBeGreaterThan(now.getTime());
  });

  it("returns a safety classifier variant", () => {
    process.env.EXPERIMENT_SAFETY_CLASSIFIER_ENABLED = "true";
    const variant = getSafetyClassifierVariant("user_123");
    expect(["llm", "rule_only"]).toContain(variant);
  });

  it("disables LLM safety classifier for rule_only bucket", () => {
    process.env.EXPERIMENT_SAFETY_CLASSIFIER_ENABLED = "true";
    process.env.EXPERIMENT_SAFETY_CLASSIFIER_SPLIT = "0,100";
    expect(isLlmSafetyClassifierEnabled("user_any")).toBe(false);
  });

  it("enables LLM safety classifier for llm bucket", () => {
    process.env.EXPERIMENT_SAFETY_CLASSIFIER_ENABLED = "true";
    process.env.EXPERIMENT_SAFETY_CLASSIFIER_SPLIT = "100,0";
    expect(isLlmSafetyClassifierEnabled("user_any")).toBe(true);
  });
});
