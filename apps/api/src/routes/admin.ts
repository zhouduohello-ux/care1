import type { FastifyInstance, FastifyRequest } from "fastify";
import { exportUserData, deleteUserData, getBucket } from "@carememory/engine";

function getAdminKey(): string | undefined {
  return process.env.ADMIN_API_KEY;
}

export default async function adminRoutes(fastify: FastifyInstance) {
  const adminKey = getAdminKey();

  fastify.addHook("onRequest", async (request, reply) => {
    if (!adminKey) {
      return reply.code(503).send({ error: "Admin API is not configured" });
    }
    const provided = request.headers["x-admin-api-key"];
    if (provided !== adminKey) {
      return reply.code(401).send({ error: "Unauthorized" });
    }
  });

  fastify.get("/admin/metrics", async (_request, reply) => {
    const now = fastify.clock.now();
    const startOfDay = new Date(now);
    startOfDay.setHours(0, 0, 0, 0);
    const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

    const [
      userCount,
      cycleCount,
      checkInCount,
      observationCount,
      eventCount,
      diseaseCardCount,
      briefCount,
      llmCallCount,
      exceptionToday,
      exceptionWeek,
    ] = await Promise.all([
      fastify.prisma.user.count(),
      fastify.prisma.cycle.count(),
      fastify.prisma.checkIn.count(),
      fastify.prisma.observation.count(),
      fastify.prisma.event.count(),
      fastify.prisma.diseaseCard.count(),
      fastify.prisma.brief.count(),
      fastify.prisma.event.count({ where: { type: "llm_call" } }),
      fastify.prisma.checkIn.count({
        where: { status: "EXCEPTION", completedAt: { gte: startOfDay } },
      }),
      fastify.prisma.checkIn.count({
        where: { status: "EXCEPTION", completedAt: { gte: sevenDaysAgo } },
      }),
    ]);

    const llmCalls = await fastify.prisma.event.findMany({
      where: { type: "llm_call" },
      select: { tokenUsage: true },
    });

    const tokenTotals = llmCalls.reduce<{ prompt: number; completion: number; total: number }>(
      (acc, call) => {
        const usage = (call.tokenUsage ?? {}) as { prompt?: number; completion?: number; total?: number };
        acc.prompt += usage.prompt ?? 0;
        acc.completion += usage.completion ?? 0;
        acc.total += usage.total ?? 0;
        return acc;
      },
      { prompt: 0, completion: 0, total: 0 }
    );

    const recentOutbound = await fastify.prisma.event.findMany({
      where: { type: "outbound_message", timestamp: { gte: sevenDaysAgo } },
      select: { payload: true },
    });
    const failedOutbound24h = recentOutbound.filter((e) => {
      const payload = (e.payload ?? {}) as { _deliveryStatus?: string; timestamp?: string };
      const ts = payload.timestamp ? new Date(payload.timestamp) : null;
      return payload._deliveryStatus === "failed" && ts && ts.getTime() >= oneDayAgo.getTime();
    }).length;

    // Experiment bucket distribution (computed from current assignments; ok for MVP scale)
    const allUsers = await fastify.prisma.user.findMany({ select: { id: true }, take: 10_000 });
    const experimentKeys = ["checkin_frequency", "conversation_style"] as const;
    const experimentAssignments: Record<string, Record<string, number>> = {};
    for (const exp of experimentKeys) {
      experimentAssignments[exp] = {};
      for (const user of allUsers) {
        const variant = getBucket(user.id, exp).variant;
        experimentAssignments[exp][variant] = (experimentAssignments[exp][variant] ?? 0) + 1;
      }
    }

    return reply.send({
      timestamp: now.toISOString(),
      counts: {
        users: userCount,
        cycles: cycleCount,
        checkIns: checkInCount,
        observations: observationCount,
        events: eventCount,
        diseaseCards: diseaseCardCount,
        briefs: briefCount,
        llmCalls: llmCallCount,
        exceptionsToday: exceptionToday,
        exceptionsThisWeek: exceptionWeek,
        failedOutbound24h,
      },
      llmTokens: tokenTotals,
      experimentAssignments,
    });
  });

  fastify.get("/admin/users", async (request: FastifyRequest<{ Querystring: { phone?: string; cursor?: string; limit?: string } }>, reply) => {
    const limit = Math.min(Number(request.query.limit ?? "50"), 200);
    const users = await fastify.prisma.user.findMany({
      where: request.query.phone ? { phoneNumber: { contains: request.query.phone } } : undefined,
      take: limit,
      cursor: request.query.cursor ? { id: request.query.cursor } : undefined,
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        phoneNumber: true,
        nickname: true,
        age: true,
        locale: true,
        timezone: true,
        consentGiven: true,
        consentAt: true,
        createdAt: true,
        updatedAt: true,
        _count: { select: { cycles: true, observations: true, events: true } },
      },
    });

    return reply.send({
      users,
      nextCursor: users.length === limit ? users[users.length - 1]?.id : undefined,
    });
  });

  fastify.get("/admin/users/:userId", async (request: FastifyRequest<{ Params: { userId: string } }>, reply) => {
    const user = await fastify.prisma.user.findUnique({
      where: { id: request.params.userId },
      select: {
        id: true,
        phoneNumber: true,
        nickname: true,
        age: true,
        locale: true,
        timezone: true,
        consentGiven: true,
        consentAt: true,
        createdAt: true,
        updatedAt: true,
        _count: { select: { cycles: true, observations: true, events: true } },
      },
    });

    if (!user) {
      return reply.code(404).send({ error: "User not found" });
    }

    return reply.send(user);
  });

  fastify.get("/admin/users/:userId/export", async (request: FastifyRequest<{ Params: { userId: string } }>, reply) => {
    const data = await exportUserData(fastify.prisma, request.params.userId, { includeAudit: true });
    if (!data) {
      return reply.code(404).send({ error: "User not found" });
    }

    return reply
      .header("Content-Disposition", "attachment; filename=\"carememory-admin-export.json\"")
      .header("Content-Type", "application/json")
      .send(data);
  });

  fastify.delete("/admin/users/:userId", async (request: FastifyRequest<{ Params: { userId: string } }>, reply) => {
    const user = await fastify.prisma.user.findUnique({ where: { id: request.params.userId }, select: { id: true } });
    if (!user) {
      return reply.code(404).send({ error: "User not found" });
    }

    await deleteUserData(fastify.prisma, request.params.userId);
    return reply.send({ deleted: true });
  });
}
