import type { FastifyInstance, FastifyRequest } from "fastify";

export default async function diseaseCardRoutes(fastify: FastifyInstance) {
  fastify.get("/api/disease-cards/:cardId", async (request: FastifyRequest<{ Params: { cardId: string }; Querystring: { t?: string } }>, reply) => {
    const { cardId } = request.params;
    const token = request.query.t;

    const card = await fastify.prisma.diseaseCard.findUnique({
      where: { id: cardId },
      include: { user: true },
    });

    if (!card || !card.accessToken || card.accessToken !== token || (card.expiresAt && card.expiresAt < fastify.clock.now())) {
      return reply.code(403).send({ error: "Invalid or expired Disease Card link" });
    }

    return reply.send({
      cardId: card.id,
      disease: card.disease,
      version: card.version,
      generatedAt: card.generatedAt,
      modules: card.modules,
      rawSummary: card.rawSummary,
      patient: {
        nickname: card.user.nickname,
      },
    });
  });
}
