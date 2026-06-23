import { prisma } from "@/lib/db";
import { notFound } from "next/navigation";
import { ModuleContent, type Module } from "@/components/DiseaseCardModule";

interface PageProps {
  params: Promise<{ cardId: string }>;
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}

export default async function DiseaseCardPage({ params, searchParams }: PageProps) {
  const { cardId } = await params;
  const { t: accessToken } = await searchParams;

  if (!accessToken || Array.isArray(accessToken)) {
    return (
      <main style={{ maxWidth: 720, margin: "0 auto", padding: "2rem" }}>
        <h1>Access denied</h1>
        <p>This Disease Card requires a valid access link.</p>
      </main>
    );
  }

  const card = await prisma.diseaseCard.findUnique({
    where: { id: cardId },
    include: { user: true },
  });

  if (!card) {
    notFound();
  }

  if (!card.accessToken || accessToken !== card.accessToken || (card.expiresAt && card.expiresAt < new Date())) {
    return (
      <main style={{ maxWidth: 720, margin: "0 auto", padding: "2rem" }}>
        <h1>Access denied</h1>
        <p>The access link is invalid or has expired.</p>
      </main>
    );
  }

  const modules = card.modules as unknown as Module[];

  return (
    <main style={{ maxWidth: 720, margin: "0 auto", padding: "2rem" }}>
      <h1>Disease Card</h1>
      <p style={{ color: "#6b7280" }}>
        {card.user.nickname ?? card.user.phoneNumber} · {card.disease} ·{" "}
        {new Date(card.generatedAt).toLocaleDateString("en-GB")}
      </p>

      {modules.map((module) => (
        <section
          key={module.id}
          style={{
            background: "#fff",
            borderRadius: 8,
            padding: "1rem",
            marginBottom: "1rem",
            boxShadow: "0 1px 3px rgba(0,0,0,0.1)",
          }}
        >
          <h2 style={{ fontSize: "1rem", marginTop: 0 }}>{module.title}</h2>
          <ModuleContent module={module} />
          {module.confidence !== undefined && module.confidence < 0.8 && (
            <p style={{ fontSize: "0.8rem", color: "#6b7280" }}>
              Confidence: {Math.round(module.confidence * 100)}%
            </p>
          )}
        </section>
      ))}

      <footer style={{ fontSize: "0.85rem", color: "#6b7280", borderTop: "1px solid #e5e7eb", paddingTop: "1rem" }}>
        <p>
          This card is based on patient-reported information only. It is not a diagnosis or medical advice.
        </p>
        <p>
          If you&apos;re having severe breathing problems, call 999 or follow your asthma action plan.
        </p>
      </footer>
    </main>
  );
}
