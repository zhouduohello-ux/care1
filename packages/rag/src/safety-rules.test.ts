import { describe, it, expect } from "vitest";
import { loadSafetyRules } from "./safety-rules.js";

describe("loadSafetyRules", () => {
  it("returns asthma safety rules from the corpus", () => {
    const rules = loadSafetyRules("asthma");
    expect(rules.prohibitedPhrases.length).toBeGreaterThan(0);
    expect(rules.requiredAddendums.length).toBeGreaterThan(0);
    expect(rules.prohibitedPhrases.some((p) => p.includes("doctor"))).toBe(true);
  });

  it("returns empty rules for unsupported diseases", () => {
    const rules = loadSafetyRules("unknown-disease");
    expect(rules.prohibitedPhrases).toEqual([]);
    expect(rules.requiredAddendums).toEqual([]);
    expect(rules.escalationTriggers).toEqual([]);
  });

  it("is case-insensitive for disease key", () => {
    const lower = loadSafetyRules("asthma");
    const upper = loadSafetyRules("ASTHMA");
    expect(upper).toEqual(lower);
  });
});
