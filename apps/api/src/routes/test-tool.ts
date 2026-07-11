import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { createHash } from "crypto";
import { processInbound, handleCheckInTrigger, type EngineContext, deleteUserData, scheduleNextCheckInOffset } from "@carememory/engine";
import { processExpiredPendingQuestions, processPendingNudges, getNudgeAfterMs, getPendingTimeoutMs } from "../services/scheduler.js";
import type { InboundMessage, Platform } from "@carememory/im-core";
import { createExportTokenFactory } from "../lib/export-token.js";
import { loadLLMConfig } from "@carememory/engine";
import { listPersonas, loadPersona } from "../test-tool/persona-library.js";
import { whatsappTemplateResolver } from "../lib/template-resolver.js";

const SimulateMessageSchema = z.object({
  userId: z.string(),
  text: z.string().optional(),
  buttonId: z.string().optional(),
});

const AdvanceTimeSchema = z.object({
  userId: z.string(),
  to: z.union([z.literal("next_checkin"), z.literal("next_day"), z.string().datetime()]),
});

const LoadPersonaSchema = z.object({
  userId: z.string(),
  personaId: z.string(),
});

const ReplaySessionSchema = z.object({
  userId: z.string(),
  sessionJson: z.record(z.unknown()),
});

const RegisterSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});

const LoginSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

export default async function testToolRoutes(fastify: FastifyInstance) {
  if (process.env.ENABLE_TEST_TOOL !== "true") {
    return;
  }

  const isProduction = process.env.NODE_ENV === "production";
  const testToolApiKey = process.env.TEST_TOOL_API_KEY;

  // In production, the test tool must be protected by an API key. If the key is
  // not set, disable the routes entirely to avoid exposing dev-only endpoints.
  if (isProduction && !testToolApiKey) {
    fastify.log.warn(
      "ENABLE_TEST_TOOL is true in production but TEST_TOOL_API_KEY is not set; test-tool routes are disabled."
    );
    return;
  }

  if (testToolApiKey) {
    fastify.addHook("onRequest", async (request, reply) => {
      const provided = request.headers["x-test-tool-api-key"];
      if (provided !== testToolApiKey) {
        return reply.code(401).send({ error: "Unauthorized", message: "Invalid or missing test-tool API key" });
      }
    });
  }

  function engineContext(userId: string): EngineContext {
    return {
      prisma: fastify.prisma,
      now: fastify.clock.now(userId),
      createExportToken: createExportTokenFactory(fastify),
      webBaseUrl: process.env.API_BASE_URL ?? "http://localhost:3055",
      llmConfig: loadLLMConfig(),
      templateResolver: whatsappTemplateResolver,
    };
  }

  function buildInboundMessage(userId: string, text?: string, buttonId?: string): InboundMessage {
    return {
      platform: "test" as Platform,
      channelId: userId,
      userId,
      messageId: `test_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      timestamp: fastify.clock.now(userId),
      content: {
        type: buttonId ? "button_reply" : "text",
        text: text ?? (buttonId ? "" : ""),
        buttonId,
        rawPayload: { userId, text, buttonId },
      },
    };
  }

  async function simulateMessage(userId: string, text?: string, buttonId?: string) {
    // In real WhatsApp, a user reply opens the 24h session window before the business
    // responds. Mirror that in the test tool so outbound message type selection sees the
    // window as open during processInbound.
    const user = await fastify.prisma.user.findUnique({ where: { phoneNumber: userId } });
    if (user) {
      await fastify.prisma.user.update({
        where: { id: user.id },
        data: { sessionWindowExpiresAt: new Date(fastify.clock.now(userId).getTime() + 24 * 60 * 60 * 1000) },
      });
    }
    const result = await processInbound(engineContext(userId), buildInboundMessage(userId, text, buttonId));
    // Keep the 24h session window open after each simulated user reply so subsequent
    // outbound questions can use interactive message types instead of templates.
    if (user) {
      await fastify.prisma.user.update({
        where: { id: user.id },
        data: { sessionWindowExpiresAt: new Date(fastify.clock.now(userId).getTime() + 24 * 60 * 60 * 1000) },
      });
    }
    return { outboundMessages: result.messages, trace: result.trace };
  }

  async function advanceTime(userId: string, to: string) {
    const now = fastify.clock.now(userId);
    let target = now;

    if (to === "next_day") {
      target = new Date(now.getTime() + 24 * 60 * 60 * 1000);
    } else if (to === "next_checkin") {
      // Jump to the earliest scheduled next check-in for this user.
      const user = await fastify.prisma.user.findUnique({ where: { phoneNumber: userId } });
      if (user) {
        const nextCycle = await fastify.prisma.cycle.findFirst({
          where: { userId: user.id, status: "ACTIVE" },
          orderBy: { nextCheckinAt: "asc" },
        });
        target = nextCycle?.nextCheckinAt ?? scheduleNextCheckInOffset(userId, now);
      }
    } else {
      target = new Date(to);
    }

    const diff = target.getTime() - now.getTime();
    if (diff > 0) {
      fastify.clock.advance(userId, diff);
    }

    const newNow = fastify.clock.now(userId);
    const user = await fastify.prisma.user.findUnique({ where: { phoneNumber: userId } });
    const outboundMessages = [];
    if (user) {
      const cycles = await fastify.prisma.cycle.findMany({
        where: { userId: user.id, status: "ACTIVE", nextCheckinAt: { lte: newNow } },
      });
      for (const cycle of cycles) {
        // For the "force next check-in" dev action, mark any unanswered active check-in as missed
        // so that handleCheckInTrigger can create a fresh one.
        if (to === "next_checkin") {
          await fastify.prisma.checkIn.updateMany({
            where: { cycleId: cycle.id, status: { in: ["SENT", "SCHEDULED"] } },
            data: { status: "MISSED" },
          });
        }

        const msgs = await handleCheckInTrigger({ prisma: fastify.prisma, now: newNow, llmConfig: loadLLMConfig(), templateResolver: whatsappTemplateResolver }, cycle.id);
        outboundMessages.push(...msgs);

        // If the engine did not schedule a next check-in (e.g. the cycle has no user bucket yet),
        // fall back to the standard offset.
        const refreshedCycle = await fastify.prisma.cycle.findUnique({ where: { id: cycle.id } });
        if (refreshedCycle && (!refreshedCycle.nextCheckinAt || refreshedCycle.nextCheckinAt <= newNow)) {
          await fastify.prisma.cycle.update({
            where: { id: cycle.id },
            data: { nextCheckinAt: scheduleNextCheckInOffset(userId, newNow) },
          });
        }
      }
    }

    return { newTime: newNow.toISOString(), outboundMessages };
  }

  fastify.post("/dev/test-tool/api/simulate-message", async (request: FastifyRequest<{ Body: { userId: string; text?: string; buttonId?: string } }>, reply) => {
    const body = SimulateMessageSchema.parse(request.body);
    const result = await simulateMessage(body.userId, body.text, body.buttonId);
    return reply.send(result);
  });

  fastify.post("/dev/test-tool/api/advance-time", async (request: FastifyRequest<{ Body: { userId: string; to: string } }>, reply) => {
    const body = AdvanceTimeSchema.parse(request.body);
    const result = await advanceTime(body.userId, body.to);
    return reply.send(result);
  });

  fastify.get("/dev/test-tool/api/session-state", async (request: FastifyRequest<{ Querystring: { userId: string } }>, reply) => {
    const userId = request.query.userId;
    const user = await fastify.prisma.user.findUnique({
      where: { phoneNumber: userId },
      include: {
        cycles: { orderBy: { startedAt: "desc" }, take: 1 },
      },
    });
    if (!user) {
      return reply.code(404).send({ error: "User not found" });
    }

    const cycle = user.cycles[0];
    const checkIn = cycle
      ? await fastify.prisma.checkIn.findFirst({
          where: { cycleId: cycle.id },
          orderBy: { scheduledAt: "desc" },
        })
      : null;

    const recentObservations = cycle
      ? await fastify.prisma.observation.findMany({
          where: { cycleId: cycle.id },
          orderBy: { timestamp: "desc" },
          take: 20,
        })
      : [];

    const recentEvents = await fastify.prisma.event.findMany({
      where: { userId: user.id },
      orderBy: { timestamp: "desc" },
      take: 20,
    });

    const diseaseCard = cycle
      ? await fastify.prisma.diseaseCard.findFirst({
          where: { cycleId: cycle.id },
          orderBy: { generatedAt: "desc" },
        })
      : null;

    return reply.send({ user, cycle, checkIn, recentObservations, recentEvents, diseaseCard });
  });

  fastify.get("/dev/test-tool/api/personas", async (_request, reply) => {
    return reply.send({ personas: listPersonas() });
  });

  fastify.post("/dev/test-tool/api/load-persona", async (request: FastifyRequest<{ Body: { userId: string; personaId: string } }>, reply) => {
    const body = LoadPersonaSchema.parse(request.body);
    const result = await loadPersona(fastify.prisma, fastify.clock, body.userId, body.personaId);
    return reply.send({ userId: result.userId, personaId: result.persona.id });
  });

  fastify.get("/dev/test-tool/api/export-session", async (request: FastifyRequest<{ Querystring: { userId: string } }>, reply) => {
    const userId = request.query.userId;
    const user = await fastify.prisma.user.findUnique({
      where: { phoneNumber: userId },
      include: {
        cycles: {
          include: {
            checkIns: true,
            observations: true,
            narrativeSummaries: true,
            events: true,
            brief: true,
          },
        },
        observations: true,
        diseaseCards: true,
        events: true,
        narrativeSummaries: true,
      },
    });
    if (!user) {
      return reply.code(404).send({ error: "User not found" });
    }
    return reply.send({ exportedAt: fastify.clock.now(userId).toISOString(), user });
  });

  fastify.post("/dev/test-tool/api/replay-session", async (request: FastifyRequest<{ Body: { userId: string; sessionJson: Record<string, unknown> } }>, reply) => {
    const body = ReplaySessionSchema.parse(request.body);
    const script = Array.isArray(body.sessionJson.script) ? (body.sessionJson.script as Record<string, unknown>[]) : [];
    const steps: unknown[] = [];

    for (const step of script) {
      const action = typeof step.action === "string" ? step.action : "";
      if (action === "send" || action === "reply") {
        const text = typeof step.text === "string" ? step.text : undefined;
        const buttonId = typeof step.buttonId === "string" ? step.buttonId : undefined;
        steps.push({ action, ...await simulateMessage(body.userId, text, buttonId) });
      } else if (action === "advance") {
        const to = typeof step.to === "string" ? step.to : "next_checkin";
        steps.push({ action, ...await advanceTime(body.userId, to) });
      }
    }

    return reply.send({ userId: body.userId, steps });
  });

  fastify.post("/dev/test-tool/api/reset-user", async (request: FastifyRequest<{ Body: { userId: string } }>, reply) => {
    const userId = request.body.userId;
    const user = await fastify.prisma.user.findUnique({ where: { phoneNumber: userId } });
    if (user) {
      await deleteUserData(fastify.prisma, user.id);
    }
    fastify.clock.resetUser(userId);
    return reply.send({ reset: true });
  });

  fastify.post("/dev/test-tool/api/trigger-expired-pending", async (request: FastifyRequest<{ Body: { userId: string } }>, reply) => {
    const { userId } = request.body;
    await processExpiredPendingQuestions(fastify.prisma, fastify.clock.now(userId), { timeoutMs: getPendingTimeoutMs() });
    return reply.send({ triggered: true });
  });

  fastify.post("/dev/test-tool/api/trigger-pending-nudge", async (request: FastifyRequest<{ Body: { userId: string } }>, reply) => {
    const { userId: _userId } = request.body;
    const outbound = await processPendingNudges(fastify.prisma, fastify.clock, { nudgeAfterMs: getNudgeAfterMs() });
    return reply.send({ triggered: true, outboundCount: outbound.length, outboundMessages: outbound });
  });

  fastify.post("/dev/test-tool/api/register", async (request: FastifyRequest<{ Body: { username: string; password: string } }>, reply) => {
    const body = RegisterSchema.parse(request.body);
    const existing = await fastify.prisma.user.findUnique({ where: { phoneNumber: body.username } });
    if (existing) {
      return reply.code(409).send({ error: "Username already taken" });
    }
    await fastify.prisma.user.create({
      data: {
        phoneNumber: body.username,
        passwordHash: sha256(body.password),
      },
    });
    return reply.send({ success: true, username: body.username });
  });

  fastify.post("/dev/test-tool/api/login", async (request: FastifyRequest<{ Body: { username: string; password: string } }>, reply) => {
    const body = LoginSchema.parse(request.body);
    const user = await fastify.prisma.user.findUnique({ where: { phoneNumber: body.username } });
    if (!user || user.passwordHash !== sha256(body.password)) {
      return reply.code(401).send({ error: "Invalid username or password" });
    }
    return reply.send({ success: true, username: body.username });
  });

  fastify.get("/dev/test-tool", async (_request, reply) => {
    // The local test tool uses inline scripts and onclick handlers; allow them for this dev-only page.
    return reply
      .header(
        "Content-Security-Policy",
        "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline';"
      )
      .sendFile("index.html");
  });
}
