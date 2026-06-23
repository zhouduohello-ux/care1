import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { generateBriefHtml } from "@carememory/brief-templates";
import { Prisma } from "@carememory/db";
import crypto from "node:crypto";
import { renderHtmlToPdf } from "../lib/pdf.js";

const GenerateBriefSchema = z.object({
  cycleId: z.string(),
});

function getDoctorFeedbackUrl(): string | undefined {
  return process.env.DOCTOR_FEEDBACK_URL;
}

export default async function briefRoutes(fastify: FastifyInstance) {
  fastify.post("/api/briefs", async (request: FastifyRequest<{ Body: { cycleId: string } }>, reply) => {
    const body = GenerateBriefSchema.parse(request.body);

    const cycle = await fastify.prisma.cycle.findUnique({
      where: { id: body.cycleId },
      include: { user: true, checkIns: true },
    });
    if (!cycle) {
      return reply.code(404).send({ error: "Cycle not found" });
    }

    const latestCard = await fastify.prisma.diseaseCard.findFirst({
      where: { cycleId: cycle.id },
      orderBy: { generatedAt: "desc" },
    });
    if (!latestCard) {
      return reply.code(400).send({ error: "No Disease Card found for this cycle" });
    }

    const accessToken = crypto.randomBytes(32).toString("hex");
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    const baseUrl = process.env.WEB_BASE_URL ?? "http://localhost:3051";

    const brief = await fastify.prisma.brief.upsert({
      where: { cycleId: cycle.id },
      update: {
        accessToken,
        expiresAt,
        generatedAt: fastify.clock.now(),
      },
      create: {
        cycleId: cycle.id,
        diseaseCardId: latestCard.id,
        accessToken,
        expiresAt,
        webUrl: "",
        generatedAt: fastify.clock.now(),
      },
    });

    const webUrl = `${baseUrl}/b/${brief.id}?t=${accessToken}`;

    const briefHtml = generateBriefHtml({
      briefId: brief.id,
      patientNickname: cycle.user.nickname,
      disease: cycle.disease,
      periodStart: cycle.startedAt.toISOString(),
      periodEnd: fastify.clock.now().toISOString(),
      diseaseCard: {
        disease: latestCard.disease,
        version: latestCard.version,
        modules: latestCard.modules as never,
        rawSummary: latestCard.rawSummary,
      },
      disclaimer:
        "This summary is based on patient-reported information only. It is not a diagnosis or medical advice. Please refer to the patient's clinical records for treatment decisions.",
      feedbackUrl: getDoctorFeedbackUrl(),
    });

    await fastify.prisma.brief.update({
      where: { id: brief.id },
      data: { webUrl },
    });

    return reply.send({ briefId: brief.id, webUrl, html: briefHtml });
  });

  fastify.get("/api/briefs/:briefId", async (request: FastifyRequest<{ Params: { briefId: string }; Querystring: { t?: string } }>, reply) => {
    const { briefId } = request.params;
    const token = request.query.t;

    const brief = await fastify.prisma.brief.findUnique({
      where: { id: briefId },
      include: { cycle: { include: { user: true } } },
    });

    if (!brief || brief.expiresAt < fastify.clock.now() || brief.accessToken !== token) {
      return reply.code(403).send({ error: "Invalid or expired brief link" });
    }

    const diseaseCard = await fastify.prisma.diseaseCard.findUnique({
      where: { id: brief.diseaseCardId ?? undefined },
    });

    if (!diseaseCard) {
      return reply.code(404).send({ error: "Disease Card not found" });
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
      feedbackUrl: getDoctorFeedbackUrl(),
    });

    return reply.type("text/html").send(html);
  });

  fastify.get("/api/briefs/:briefId/pdf", async (request: FastifyRequest<{ Params: { briefId: string }; Querystring: { t?: string } }>, reply) => {
    const { briefId } = request.params;
    const token = request.query.t;

    const brief = await fastify.prisma.brief.findUnique({
      where: { id: briefId },
      include: { cycle: { include: { user: true } } },
    });

    if (!brief || brief.expiresAt < fastify.clock.now() || brief.accessToken !== token) {
      return reply.code(403).send({ error: "Invalid or expired brief link" });
    }

    const diseaseCard = brief.diseaseCardId
      ? await fastify.prisma.diseaseCard.findUnique({ where: { id: brief.diseaseCardId } })
      : null;

    if (!diseaseCard) {
      return reply.code(404).send({ error: "Disease Card not found" });
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
      feedbackUrl: getDoctorFeedbackUrl(),
    });

    const pdf = await renderHtmlToPdf(html);
    return reply
      .header("Content-Type", "application/pdf")
      .header("Content-Disposition", `attachment; filename="asthma-visit-brief-${briefId}.pdf"`)
      .send(pdf);
  });
}
