import type { FastifyInstance, FastifyRequest } from "fastify";
import { resolveUserAccessToken } from "../lib/user-token.js";

export default async function recordsRoutes(fastify: FastifyInstance) {
  fastify.get("/api/records", async (request: FastifyRequest<{ Querystring: { t?: string } }>, reply) => {
    const token = request.query.t;
    if (!token) {
      return reply.code(401).send({ error: "Missing access token" });
    }

    const userId = await resolveUserAccessToken(fastify.redis, token);
    if (!userId) {
      return reply.code(403).send({ error: "Invalid or expired access token" });
    }

    const user = await fastify.prisma.user.findUnique({
      where: { id: userId },
      include: {
        cycles: {
          orderBy: { startedAt: "desc" },
          include: {
            checkIns: { orderBy: { scheduledAt: "desc" } },
            observations: { orderBy: { timestamp: "desc" } },
            narrativeSummaries: { orderBy: { generatedAt: "desc" } },
            brief: true,
          },
        },
        observations: { orderBy: { timestamp: "desc" }, take: 100 },
        diseaseCards: { orderBy: { generatedAt: "desc" } },
        events: { orderBy: { timestamp: "desc" }, take: 100 },
      },
    });

    if (!user) {
      return reply.code(404).send({ error: "User not found" });
    }

    return reply.send({
      profile: {
        nickname: user.nickname,
        phoneNumber: user.phoneNumber,
        nextVisitAt: user.nextVisitAt,
        medications: user.medications,
      },
      cycles: user.cycles,
      observations: user.observations,
      diseaseCards: user.diseaseCards,
      events: user.events,
    });
  });
}
