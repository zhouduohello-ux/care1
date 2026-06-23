import type { FastifyInstance, FastifyRequest } from "fastify";
import { exportUserData } from "@carememory/engine";
import { resolveExportToken } from "../lib/export-token.js";

export default async function exportRoutes(fastify: FastifyInstance) {
  fastify.get("/api/export", async (request: FastifyRequest<{ Querystring: { t?: string } }>, reply) => {
    const token = request.query.t;
    if (!token) {
      return reply.code(400).send({ error: "Missing export token" });
    }

    const userId = await resolveExportToken(fastify.redis, token);
    if (!userId) {
      return reply.code(403).send({ error: "Invalid or expired export token" });
    }

    const data = await exportUserData(fastify.prisma, userId);
    if (!data) {
      return reply.code(404).send({ error: "User not found" });
    }

    return reply
      .header("Content-Disposition", "attachment; filename=\"carememory-export.json\"")
      .header("Content-Type", "application/json")
      .send(data);
  });
}
