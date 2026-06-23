import type { GeneratedDiseaseCard, DiseaseCardModule } from "@carememory/disease-card";

export interface BriefData {
  briefId: string;
  patientNickname?: string | null;
  disease: string;
  periodStart: string;
  periodEnd: string;
  diseaseCard: GeneratedDiseaseCard;
  disclaimer: string;
  feedbackUrl?: string;
}

export function generateBriefHtml(data: BriefData): string {
  const moduleById = (id: string) => data.diseaseCard.modules.find((m) => m.id === id);
  const headline = moduleById("headline")?.content as string | undefined;
  const control = moduleById("control_status")?.content as { status: string; reason: string } | undefined;
  const symptoms = moduleById("symptom_trend")?.content as { latest: unknown; values: unknown[] } | undefined;
  const medication = moduleById("medication")?.content as { latest: unknown; values: unknown[] } | undefined;
  const function_ = moduleById("function")?.content as { latest: unknown } | undefined;
  const questions = moduleById("questions")?.content as string[] | undefined;

  const formatDate = (iso: string) =>
    new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Asthma Visit Brief</title>
  <style>
    body { font-family: system-ui, -apple-system, sans-serif; color: #1f2937; line-height: 1.6; max-width: 720px; margin: 0 auto; padding: 2rem; }
    h1 { font-size: 1.6rem; margin-bottom: 0.25rem; }
    .subtitle { color: #6b7280; font-size: 0.95rem; margin-bottom: 1.5rem; }
    .section { margin-bottom: 1.5rem; }
    .section h2 { font-size: 1.1rem; border-bottom: 2px solid #e5e7eb; padding-bottom: 0.25rem; margin-bottom: 0.5rem; }
    .status { display: inline-block; padding: 0.25rem 0.75rem; border-radius: 9999px; font-weight: 600; font-size: 0.9rem; }
    .status.well { background: #d1fae5; color: #065f46; }
    .status.attention { background: #fef3c7; color: #92400e; }
    .status.unstable { background: #fee2e2; color: #991b1b; }
    .box { background: #f9fafb; border-radius: 8px; padding: 1rem; }
    ul { margin: 0; padding-left: 1.25rem; }
    .disclaimer { border-top: 1px solid #e5e7eb; padding-top: 1rem; font-size: 0.85rem; color: #6b7280; }
    @media print { body { padding: 0; } }
  </style>
</head>
<body>
  <h1>Asthma Visit Brief — ${escapeHtml(data.patientNickname ?? "Patient")}</h1>
  <div class="subtitle">${formatDate(data.periodStart)} – ${formatDate(data.periodEnd)}</div>

  <div class="section">
    <h2>Headline</h2>
    <p>${escapeHtml(headline ?? "No summary available.")}</p>
  </div>

  <div class="section">
    <h2>Control Status</h2>
    <span class="status ${statusClass(control?.status)}">${escapeHtml(control?.status ?? "Unknown")}</span>
    <p>${escapeHtml(control?.reason ?? "")}</p>
  </div>

  <div class="section">
    <h2>Key Signals</h2>
    <div class="box">
      <p><strong>Nighttime symptoms:</strong> ${escapeHtml(String(symptoms?.latest ?? "No data"))}</p>
      <p><strong>Reliever inhaler use:</strong> ${escapeHtml(String(medication?.latest ?? "No data"))}</p>
      <p><strong>Activity limitation:</strong> ${escapeHtml(String(function_?.latest ?? "No data"))}</p>
    </div>
  </div>

  ${questions && questions.length > 0 ? `
  <div class="section">
    <h2>Questions for Your Doctor</h2>
    <ul>${questions.map((q) => `<li>${escapeHtml(String(q))}</li>`).join("")}</ul>
  </div>
  ` : ""}

  ${data.feedbackUrl ? `
  <div class="section">
    <h2>Doctor feedback</h2>
    <p>
      <a href="${escapeHtml(data.feedbackUrl)}" target="_blank" rel="noopener noreferrer">
        Tell us if this summary was useful (opens in a new tab)
      </a>
    </p>
  </div>
  ` : ""}

  <div class="section disclaimer">
    <p>${escapeHtml(data.disclaimer)}</p>
    <p>If you're having severe breathing problems, call 999 or follow your asthma action plan.</p>
  </div>
</body>
</html>`;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function statusClass(status?: string): string {
  if (status === "Well controlled") return "well";
  if (status === "Unstable") return "unstable";
  return "attention";
}
