import type { PrismaClient, ObservationCategory, EventType } from "@carememory/db";
import { Prisma } from "@carememory/db";
import type { InboundMessage, OutboundMessage } from "@carememory/im-core";
import crypto from "node:crypto";
import type { Observation, PerceptionResult, PlannerOutput } from "./types.js";
import type { LLMClient, LLMMessage } from "./llm.js";

function makeOutboundIdempotencyKey(message: OutboundMessage, now: Date, salt: string): string {
  const hash = crypto
    .createHash("sha256")
    .update(`${message.userId}:${now.toISOString()}:${salt}:${message.content.text}`)
    .digest("hex")
    .slice(0, 16);
  return `out:${message.userId}:${now.getTime()}:${salt}:${hash}`;
}

export async function saveInboundMessage(
  prisma: PrismaClient,
  userId: string,
  message: InboundMessage,
  cycleId?: string,
  traceId?: string
): Promise<string> {
  const event = await prisma.event.create({
    data: {
      userId,
      cycleId,
      type: "inbound_message" as EventType,
      payload: message as unknown as Prisma.InputJsonValue,
      platformMessageId: message.messageId,
      traceId,
      timestamp: message.timestamp,
    },
  });
  return event.id;
}

export async function saveOutboundMessages(
  prisma: PrismaClient,
  userId: string,
  messages: OutboundMessage[],
  cycleId?: string,
  now: Date = new Date(),
  salt?: string,
  traceId?: string,
  pendingQuestion?: import("./turn-manager.js").PendingQuestion
): Promise<string[]> {
  const keys: string[] = [];
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];
    const keySalt = salt ?? `${now.getTime()}_${i}`;
    const idempotencyKey = message.idempotencyKey ?? makeOutboundIdempotencyKey(message, now, keySalt);
    message.idempotencyKey = idempotencyKey;
    await prisma.event.create({
      data: {
        userId,
        cycleId,
        type: "outbound_message" as EventType,
        payload: {
          ...message,
          _deliveryStatus: "pending",
          ...(pendingQuestion ? { _pendingQuestion: pendingQuestion } : {}),
        } as unknown as Prisma.InputJsonValue,
        idempotencyKey,
        traceId,
        timestamp: new Date(now.getTime() + i),
      },
    });
    keys.push(idempotencyKey);
  }
  return keys;
}

export async function saveObservations(
  prisma: PrismaClient,
  userId: string,
  cycleId: string,
  eventId: string,
  observations: Observation[],
  timestamp?: Date
): Promise<string[]> {
  const ids: string[] = [];
  for (const obs of observations) {
    const created = await prisma.observation.create({
      data: {
        userId,
        cycleId,
        eventId,
        timestamp: timestamp ?? new Date(),
        category: obs.category as ObservationCategory,
        concept: obs.concept,
        value: obs.value as Prisma.InputJsonValue,
        attributes: (obs.attributes ?? {}) as Prisma.InputJsonValue,
        confidence: obs.confidence ?? 1.0,
        extractedBy: obs.extractedBy ?? "rule",
      },
    });
    ids.push(created.id);
  }
  return ids;
}

export async function savePerceptionEvent(
  prisma: PrismaClient,
  userId: string,
  cycleId: string | undefined,
  perception: PerceptionResult,
  traceId?: string
): Promise<void> {
  await prisma.event.create({
    data: {
      userId,
      cycleId,
      type: "observation_extracted" as EventType,
      payload: perception as unknown as Prisma.InputJsonValue,
      traceId,
    },
  });
}

export async function savePlannerEvent(
  prisma: PrismaClient,
  userId: string,
  cycleId: string | undefined,
  plannerOutput: PlannerOutput,
  traceId?: string
): Promise<void> {
  await prisma.event.create({
    data: {
      userId,
      cycleId,
      type: "state_updated" as EventType,
      payload: plannerOutput as unknown as Prisma.InputJsonValue,
      traceId,
    },
  });
}

export async function saveLlmCallEvent(
  prisma: PrismaClient,
  userId: string,
  cycleId: string | undefined,
  model: string,
  input: unknown,
  output: string,
  tokenUsage?: { promptTokens?: number; completionTokens?: number; totalTokens?: number },
  traceId?: string
): Promise<void> {
  await prisma.event.create({
    data: {
      userId,
      cycleId,
      type: "llm_call" as EventType,
      payload: { output } as unknown as Prisma.InputJsonValue,
      llmModel: model,
      llmInput: input as unknown as Prisma.InputJsonValue,
      llmOutput: { output } as unknown as Prisma.InputJsonValue,
      tokenUsage: tokenUsage as unknown as Prisma.InputJsonValue,
      traceId,
    },
  });
}

/**
 * Build a condensed textual summary of recent observations and call LLM to
 * generate a natural-language narrative. Saves the result as a session-level
 * NarrativeSummary.
 *
 * Follows func-spec §5.3 step 3: "异步触发 Narrative Summary 更新".
 * Uses the model configured for "perception" (tech-spec §6.1 recommends GPT-4o-mini).
 */
export async function generateSessionNarrativeSummary(
  prisma: PrismaClient,
  userId: string,
  cycleId: string,
  checkInId: string,
  observations: Observation[],
  llmClient: LLMClient,
  now: Date
): Promise<void> {
  // Condense observations into a structured text prompt
  const lines = observations.map((o, i) =>
    `[${i + 1}] ${o.category}: ${o.concept} = ${JSON.stringify(o.value)}${o.attributes ? ` (${JSON.stringify(o.attributes)})` : ""}`
  );
  const obsText = lines.join("\n");

  const systemPrompt = `You are the narrative summariser for CareMemory, a UK asthma follow-up assistant.
Given a patient's reported observations from a single check-in session, produce a concise 2–3 sentence narrative in plain English.
Focus on what changed, notable symptoms, medication use, triggers, and any concerns the patient raised.
Do not diagnose, do not give treatment advice, and do not use clinical scale scores.`;

  const userPrompt = `Check-in observations:\n${obsText || "No observations recorded for this session."}`;

  const messages: LLMMessage[] = [
    { role: "system", content: systemPrompt },
    { role: "user", content: userPrompt },
  ];

  const { content } = await llmClient.complete(messages);

  await prisma.narrativeSummary.create({
    data: {
      userId,
      cycleId,
      scope: "session",
      generatedAt: now,
      content,
      keyObservationIds: observations.map((o) => o.id ?? ""),
    },
  });
}

export async function deleteUserData(prisma: PrismaClient, userId: string): Promise<void> {
  // Hard delete all user data in dependency order to satisfy GDPR right to erasure.
  const cycles = await prisma.cycle.findMany({ where: { userId }, select: { id: true } });
  const cycleIds = cycles.map((c) => c.id);

  await prisma.brief.deleteMany({ where: { cycleId: { in: cycleIds } } });
  await prisma.diseaseCard.deleteMany({ where: { userId } });
  await prisma.narrativeSummary.deleteMany({ where: { userId } });
  await prisma.observation.deleteMany({ where: { userId } });
  await prisma.event.deleteMany({ where: { userId } });
  await prisma.checkIn.deleteMany({ where: { cycleId: { in: cycleIds } } });
  await prisma.cycle.deleteMany({ where: { userId } });
  await prisma.user.delete({ where: { id: userId } });
}

export async function exportUserData(
  prisma: PrismaClient,
  userId: string,
  options: { includeAudit?: boolean } = {}
) {
  const { includeAudit = false } = options;
  const user = await prisma.user.findUnique({
    where: { id: userId },
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
      diseaseCards: true,
      observations: true,
      events: true,
      narrativeSummaries: true,
    },
  });

  if (!user) {
    return null;
  }

  const { id, phoneNumber, waId, locale, timezone, nickname, age, medications, nextVisitAt, lastInboundAt, sessionWindowExpiresAt, createdAt, updatedAt, consentGiven, consentAt, consentVersion } = user;

  const eventFilter = (e: { type: string }) => includeAudit || e.type !== "llm_call";

  return {
    formatVersion: "carememory-gdpr-export-v1",
    exportedAt: new Date().toISOString(),
    dataController: "CareMemory Ltd",
    exportNotice: "This export contains personal health information reported by the user. System audit logs (LLM calls) are excluded unless explicitly requested.",
    profile: { id, phoneNumber, waId, locale, timezone, nickname, age, medications, nextVisitAt, lastInboundAt, sessionWindowExpiresAt, createdAt, updatedAt, consentGiven, consentAt, consentVersion },
    cycles: user.cycles.map((cycle) => ({
      ...cycle,
      events: cycle.events.filter(eventFilter),
    })),
    observations: user.observations,
    diseaseCards: user.diseaseCards,
    events: user.events.filter(eventFilter),
    narrativeSummaries: user.narrativeSummaries,
  };
}

export async function supersedePreviousObservations(
  prisma: PrismaClient,
  cycleId: string,
  concept: string,
  supersededById: string
): Promise<void> {
  const previous = await prisma.observation.findFirst({
    where: { cycleId, concept, superseded: false },
    orderBy: { timestamp: "desc" },
  });
  if (previous && previous.id !== supersededById) {
    await prisma.observation.update({
      where: { id: previous.id },
      data: { superseded: true, supersededById },
    });
  }
}

export async function getRecentObservations(
  prisma: PrismaClient,
  userId: string,
  cycleId: string,
  after?: Date,
  limit = 20
): Promise<Observation[]> {
  const where: { userId: string; cycleId: string; superseded: boolean; timestamp?: { gte: Date } } = {
    userId,
    cycleId,
    superseded: false,
  };
  if (after) {
    where.timestamp = { gte: after };
  }

  const rows = await prisma.observation.findMany({
    where,
    orderBy: { timestamp: "desc" },
    take: limit,
  });

  return rows.map((row) => ({
    category: row.category as ObservationCategory,
    concept: row.concept,
    value: row.value,
    attributes: (row.attributes as Record<string, unknown> | null) ?? undefined,
    confidence: row.confidence,
    extractedBy: row.extractedBy as "rule" | "llm",
  }));
}
