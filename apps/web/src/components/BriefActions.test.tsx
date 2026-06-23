import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { BriefActions } from "./BriefActions";

describe("BriefActions", () => {
  it("renders a PDF download link with the correct URL", () => {
    render(<BriefActions briefId="brief_123" token="secret-token" apiBaseUrl="http://localhost:3055" />);

    const link = screen.getByRole("link", { name: /download pdf/i });
    expect(link).toHaveAttribute("href", "http://localhost:3055/api/briefs/brief_123/pdf?t=secret-token");
    expect(link).toHaveAttribute("download");
  });

  it("renders a feedback link when feedbackUrl is provided", () => {
    render(
      <BriefActions
        briefId="brief_123"
        token="secret-token"
        apiBaseUrl="http://localhost:3055"
        feedbackUrl="https://forms.example.com/feedback"
      />
    );

    const feedbackLink = screen.getByRole("link", { name: /give feedback/i });
    expect(feedbackLink).toHaveAttribute("href", "https://forms.example.com/feedback");
    expect(feedbackLink).toHaveAttribute("target", "_blank");
    expect(feedbackLink).toHaveAttribute("rel", "noopener noreferrer");
  });

  it("does not render a feedback link when feedbackUrl is omitted", () => {
    render(<BriefActions briefId="brief_123" token="secret-token" apiBaseUrl="http://localhost:3055" />);

    expect(screen.queryByRole("link", { name: /give feedback/i })).not.toBeInTheDocument();
  });
});
