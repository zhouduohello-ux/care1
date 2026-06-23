import type { FastifyInstance } from "fastify";

export default async function healthRoutes(fastify: FastifyInstance) {
  fastify.get("/health", async () => {
    const checks: Record<string, "ok" | "error"> = {};

    try {
      await fastify.prisma.$queryRaw`SELECT 1`;
      checks.database = "ok";
    } catch (err) {
      fastify.log.error({ err }, "health check: database failed");
      checks.database = "error";
    }

    try {
      await fastify.redis.ping();
      checks.redis = "ok";
    } catch (err) {
      fastify.log.error({ err }, "health check: redis failed");
      checks.redis = "error";
    }

    const allHealthy = Object.values(checks).every((v) => v === "ok");
    return {
      status: allHealthy ? "ok" : "degraded",
      timestamp: fastify.clock.now().toISOString(),
      version: process.env.RELEASE ?? "dev",
      checks,
    };
  });
}
