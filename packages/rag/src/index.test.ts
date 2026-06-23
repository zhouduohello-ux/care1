import { describe, it, expect } from "vitest";
import { loadDiseaseCorpus, searchCorpus } from "./index.js";

describe("rag corpus", () => {
  it("loads asthma corpus sections", () => {
    const corpus = loadDiseaseCorpus("asthma");
    expect(corpus.disease).toBe("asthma");
    expect(corpus.sections.length).toBeGreaterThan(0);
    const titles = corpus.sections.map((s) => s.title);
    expect(titles).toContain("Asthma Care Strategy");
    expect(titles).toContain("Asthma Safety Rules");
  });

  it("returns empty corpus for unknown disease", () => {
    const corpus = loadDiseaseCorpus("unknown-disease");
    expect(corpus.sections).toEqual([]);
  });

  it("retrieves safety rules for severe symptom query", () => {
    const corpus = loadDiseaseCorpus("asthma");
    const results = searchCorpus(corpus, "severe breathing emergency 999", { topK: 2 });
    expect(results.length).toBe(2);
    const text = results.map((r) => `${r.title} ${r.content}`).join(" ");
    expect(text).toMatch(/emergency|999|severe/i);
  });

  it("retrieves care strategy for check-in planning", () => {
    const corpus = loadDiseaseCorpus("asthma");
    const results = searchCorpus(corpus, "nighttime symptoms reliever use check-in", { topK: 2 });
    expect(results.length).toBe(2);
    const titles = results.map((r) => r.title);
    expect(titles.some((t) => /care strategy|conversation patterns/i.test(t))).toBe(true);
  });
});
