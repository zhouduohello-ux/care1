import { describe, it, expect } from "vitest";
import { classifyMedicationType, parseMedications } from "./onboarding.js";

describe("onboarding medication parsing", () => {
  it("classifies common controller medications", () => {
    expect(classifyMedicationType("Seretide")).toBe("controller");
    expect(classifyMedicationType("Symbicort")).toBe("controller");
    expect(classifyMedicationType("Fostair")).toBe("controller");
    expect(classifyMedicationType("Qvar")).toBe("controller");
  });

  it("classifies common reliever medications", () => {
    expect(classifyMedicationType("Ventolin")).toBe("reliever");
    expect(classifyMedicationType("Salbutamol")).toBe("reliever");
    expect(classifyMedicationType("Bricanyl")).toBe("reliever");
  });

  it("returns unspecified for ambiguous names", () => {
    expect(classifyMedicationType("Aspirin")).toBe("unspecified");
    expect(classifyMedicationType("Vitamin D")).toBe("unspecified");
  });

  it("parses comma-separated medications and auto-classifies", () => {
    const parsed = parseMedications("Seretide, Ventolin");
    expect(parsed).toEqual({
      baseline: [
        { name: "Seretide", type: "controller" },
        { name: "Ventolin", type: "reliever" },
      ],
    });
  });

  it("accepts explicit type annotations", () => {
    const parsed = parseMedications("Seretide (controller), Ventolin (reliever)");
    expect(parsed).toEqual({
      baseline: [
        { name: "Seretide", type: "controller" },
        { name: "Ventolin", type: "reliever" },
      ],
    });
  });

  it("treats preventer as controller", () => {
    const parsed = parseMedications("Clenil - preventer");
    expect(parsed?.baseline[0].type).toBe("controller");
  });

  it("returns empty baseline for SKIP", () => {
    expect(parseMedications("SKIP")).toEqual({ baseline: [] });
    expect(parseMedications("skip")).toEqual({ baseline: [] });
  });

  it("returns null for empty input", () => {
    expect(parseMedications("")).toBeNull();
  });
});
