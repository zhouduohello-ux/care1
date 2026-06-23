import { prisma } from "@/lib/db";
import { notFound } from "next/navigation";
import { generateBriefHtml } from "@carememory/brief-templates";
import { BriefActions } from "@/components/BriefActions";

interface PageProps {
  params: Promise<{ briefId: string }>;
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}

export default async function BriefPage({ params, searchParams }: PageProps) {
  const { briefId } = await params;
  const { t: accessToken } = await searchParams;

  if (!accessToken || Array.isArray(accessToken)) {
    return (
      <main style={{ maxWidth: 720, margin: "0 auto", padding: "2rem" }}>
        <h1>Access denied</h1>
        <p>This brief requires a valid access link.</p>
      </main>
    );
  }

  const brief = await prisma.brief.findUnique({
    where: { id: briefId },
    include: { cycle: { include: { user: true } } },
  });

  if (!brief || brief.accessToken !== accessToken || brief.expiresAt < new Date()) {
    return (
      <main style={{ maxWidth: 720, margin: "0 auto", padding: "2rem" }}>
        <h1>Access denied</h1>
        <p>This brief link is invalid or has expired.</p>
      </main>
    );
  }

  const diseaseCard = brief.diseaseCardId
    ? await prisma.diseaseCard.findUnique({ where: { id: brief.diseaseCardId } })
    : null;

  if (!diseaseCard) {
    notFound();
  }

  const html = generateBriefHtml({
    briefId: brief.id,
    patientNickname: brief.cycle.user.nickname,
    disease: brief.cycle.disease,
    periodStart: brief.cycle.startedAt.toISOString(),
    periodEnd: brief.generatedAt.toISOString(),
    diseaseCard: {
      disease: diseaseCard.disease,
      version: diseaseCard.version,
      modules: diseaseCard.modules as never,
      rawSummary: diseaseCard.rawSummary,
    },
    disclaimer:
      "This summary is based on patient-reported information only. It is not a diagnosis or medical advice. Please refer to the patient's clinical records for treatment decisions.",
  });

  return (
    <>
      <BriefActions
        briefId={brief.id}
        token={accessToken}
        apiBaseUrl={process.env.API_BASE_URL ?? "http://localhost:3055"}
        feedbackUrl={process.env.DOCTOR_FEEDBACK_URL}
      />
      <div dangerouslySetInnerHTML={{ __html: html }} />
    </>
  );
}
