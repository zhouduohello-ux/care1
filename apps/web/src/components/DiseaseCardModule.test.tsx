import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { ModuleContent, StatusBadge } from "./DiseaseCardModule";

describe("StatusBadge", () => {
  it.each([
    ["Well controlled", "#d1fae5"],
    ["Needs attention", "#fef3c7"],
    ["Unstable", "#fee2e2"],
    ["Unknown", "#f3f4f6"],
  ])("renders %s with the expected background color", (status, expectedBg) => {
    render(<StatusBadge status={status} />);
    const badge = screen.getByText(status);
    expect(badge).toBeInTheDocument();
    expect(badge).toHaveStyle({ background: expectedBg });
  });
});

describe("ModuleContent", () => {
  it("renders headline content as text", () => {
    render(<ModuleContent module={{ id: "m1", title: "Headline", type: "headline", content: "Patient feels well." }} />);
    expect(screen.getByText("Patient feels well.")).toBeInTheDocument();
  });

  it("renders safety content as text", () => {
    render(<ModuleContent module={{ id: "m2", title: "Safety", type: "safety", content: "Call 999 in an emergency." }} />);
    expect(screen.getByText("Call 999 in an emergency.")).toBeInTheDocument();
  });

  it("renders control status with a badge and reason", () => {
    render(
      <ModuleContent
        module={{
          id: "m3",
          title: "Control",
          type: "control_status",
          content: { status: "Well controlled", reason: "No reliever use this week." },
        }}
      />
    );

    expect(screen.getByText("Well controlled")).toBeInTheDocument();
    expect(screen.getByText("No reliever use this week.")).toBeInTheDocument();
  });

  it("renders symptom trend with latest and history", () => {
    render(
      <ModuleContent
        module={{
          id: "m4",
          title: "Night symptoms",
          type: "symptom_trend",
          content: { latest: "None", values: ["Mild", "None", "None"] },
        }}
      />
    );

    expect(screen.getByText((_, el) => el?.textContent === "Latest: None")).toBeInTheDocument();
    expect(screen.getByText((_, el) => el?.textContent === "History: Mild → None → None")).toBeInTheDocument();
  });

  it("renders triggers as a list", () => {
    render(
      <ModuleContent
        module={{
          id: "m5",
          title: "Triggers",
          type: "triggers",
          content: ["Exercise", "Pollen"],
        }}
      />
    );

    expect(screen.getByText("Exercise")).toBeInTheDocument();
    expect(screen.getByText("Pollen")).toBeInTheDocument();
  });

  it("falls back to JSON for unknown module types", () => {
    render(
      <ModuleContent
        module={{
          id: "m6",
          title: "Unknown",
          type: "custom",
          content: { foo: "bar" },
        }}
      />
    );

    expect(screen.getByText(/"foo": "bar"/)).toBeInTheDocument();
  });
});
