"use client";

interface BriefActionsProps {
  briefId: string;
  token: string;
  apiBaseUrl: string;
  feedbackUrl?: string;
}

export function BriefActions({ briefId, token, apiBaseUrl, feedbackUrl }: BriefActionsProps) {
  const pdfUrl = `${apiBaseUrl}/api/briefs/${briefId}/pdf?t=${encodeURIComponent(token)}`;

  return (
    <div style={{ display: "flex", gap: "0.75rem", marginBottom: "1.5rem", flexWrap: "wrap" }}>
      <a
        href={pdfUrl}
        download
        style={{
          display: "inline-block",
          padding: "0.6rem 1.2rem",
          background: "#0ea5e9",
          color: "#fff",
          textDecoration: "none",
          borderRadius: 6,
          fontWeight: 600,
        }}
      >
        Download PDF
      </a>
      {feedbackUrl && (
        <a
          href={feedbackUrl}
          target="_blank"
          rel="noopener noreferrer"
          style={{
            display: "inline-block",
            padding: "0.6rem 1.2rem",
            background: "#f3f4f6",
            color: "#374151",
            textDecoration: "none",
            borderRadius: 6,
            fontWeight: 600,
          }}
        >
          Give feedback
        </a>
      )}
    </div>
  );
}
