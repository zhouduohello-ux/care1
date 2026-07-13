import type { InboundMessage, OutboundMessage } from "@carememory/im-core";
import { generateDiseaseCard } from "@carememory/disease-card";
import { Prisma } from "@carememory/db";
import type { Cycle, User, CheckIn } from "@carememory/db";
import crypto from "node:crypto";
import type { EngineContext, EngineTrace, LlmModelType, PlannerOutput, SafetyResult } from "./types.js";
import { perceive } from "./perception.js";
import { safetyCheck } from "./safety.js";
import { plan } from "./planner.js";
import { renderMessage } from "./dialogue.js";
import { createOpenAIClient, type LLMClient, layerProvider } from "./llm.js";
import {
  pendingQuestionFromPlannerOutput,
  getTurnState,
  evaluateAnswerToPendingQuestion,
  isAnswerToPendingQuestion,
  isAnswerRelevantWithLlm,
  buildRepromptMessage,
  buildClarificationMessage,
  looksLikeClarificationRequest,
  looksLikeSkipRequest,
  recordSkippedQuestion,
  looksLikeGoBackRequest,
  goBackToPreviousQuestion,
  buildPreviousQuestionMessage,
  detectPartialMultiSelectAnswer,
  buildPartialAnswerFollowUpMessage,
  classifyNonAnswer,
  recordReprompt,
  clearPendingQuestion,
  setPendingQuestion,
  getMaxReprompts,
  getLlmAnswerRelevanceThreshold,
  getSessionTurnBudget,
  detectTopicShift,
  buildTopicShiftAcknowledgementMessage,
  recordTopicShift,
  MAX_REPROMPTS,
  detectTopicShift,
  deferPendingQuestion,
  popDeferredQuestion,
  buildDeferredQuestionMessage,
  type PendingQuestion,
  type AnswerConfidenceResult,
} from "./turn-manager.js";
import { hasLlmQuota, incrementLlmQuota } from "./llm-quota.js";
import { scheduleNextCheckInOffset, getBucket } from "./experiments.js";
import {
  saveInboundMessage,
  saveOutboundMessages,
  saveObservations,
  savePerceptionEvent,
  savePlannerEvent,
  saveLlmCallEvent,
  getRecentObservations,
  deleteUserData,
  supersedePreviousObservations,
  generateSessionNarrativeSummary,
} from "./memory.js";
import { handleOnboardingInput, askNext, getPendingOnboardingField } from "./onboarding.js";
import { hasControllerMedication, type MedicationBaseline } from "./question-bank.js";

export * from "./types.js";
export { perceive, safetyCheck, plan, renderMessage };

const RISK_ORDER: Record<SafetyResult["riskLevel"], number> = {
  none: 0,
  low: 1,
  medium: 2,
  high: 3,
};

function emptyPlannerOutput(purpose: string): PlannerOutput {
  return {
    reasoning: "Handled directly by system command or edge case logic.",
    sessionObjective: "",
    nextAction: { type: "inform", topic: "system", purpose, budgetCost: 0 },
    safetyFlag: "none",
    updatePatientState: {},
  };
}

/** Cache OpenAI clients by (layer, model, temperature) tuple. */
const llmClientCache = new Map<string, LLMClient>();

function isSessionOpen(user: { sessionWindowExpiresAt?: Date | null }, now: Date): boolean {
  return !!user.sessionWindowExpiresAt && user.sessionWindowExpiresAt.getTime() > now.getTime();
}

function resolveLlmClient(context: EngineContext, model: LlmModelType): LLMClient | undefined {
  const cfg = context.llmConfig;
  if (!cfg?.enabled) return undefined;

  const layerConfig = cfg.layers[model];
  const provider = layerProvider(model);
  const providerConfig = cfg[provider];

  if (!providerConfig.apiKey || !providerConfig.baseUrl) return undefined;

  const effectiveModel = layerConfig.model || providerConfig.model;
  if (!effectiveModel) return undefined;

  const cacheKey = `${model}:${provider}:${effectiveModel}:${layerConfig.temperature}:${cfg.timeoutMs}:${cfg.maxRetries}:${cfg.retryBaseDelayMs}`;

  let client = llmClientCache.get(cacheKey);
  if (!client) {
    client = createOpenAIClient({
      apiKey: providerConfig.apiKey,
      baseUrl: providerConfig.baseUrl,
      model: effectiveModel,
      fallbackModel: providerConfig.fallbackModel,
      temperature: layerConfig.temperature,
      timeoutMs: cfg.timeoutMs,
      maxRetries: cfg.maxRetries,
      retryBaseDelayMs: cfg.retryBaseDelayMs,
    });
    llmClientCache.set(cacheKey, client);
  }
  return client;
}

function summarizeSafety(results: SafetyResult[]): SafetyResult {
  let approved = true;
  let riskLevel: SafetyResult["riskLevel"] = "none";
  const addendums: string[] = [];
  let blockReason: string | undefined;

  for (const r of results) {
    if (!r.approved) {
      approved = false;
      blockReason = r.blockReason;
    }
    if (RISK_ORDER[r.riskLevel] > RISK_ORDER[riskLevel]) {
      riskLevel = r.riskLevel;
    }
    for (const a of r.requiredAddendums) {
      if (!addendums.includes(a)) addendums.push(a);
    }
  }

  return { approved, riskLevel, requiredAddendums: addendums, blockReason };
}


async function finalizeCheckInSession(
  context: EngineContext,
  user: User,
  cycle: Cycle,
  activeCheckIn: CheckIn,
  inboundEventId: string,
  traceId: string | undefined,
  style: "v1" | "v2",
  status: "COMPLETED" | "EXCEPTION"
): Promise<OutboundMessage[]> {
  const prisma = context.prisma;
  const userId = user.phoneNumber;

  await prisma.checkIn.update({
    where: { id: activeCheckIn.id },
    data: { status, completedAt: context.now },
  });

  // Generate session-level narrative summary (func-spec §5.3 step 3)
  const narrativeClient = resolveLlmClient(context, "perception");
  if (narrativeClient) {
    const sessionObservations = await getRecentObservations(prisma, user.id, cycle.id, activeCheckIn.sentAt ?? undefined);
    await generateSessionNarrativeSummary(
      prisma, user.id, cycle.id, activeCheckIn.id, sessionObservations, narrativeClient, context.now
    );
  }

  const allObservations = await prisma.observation.findMany({
    where: { cycleId: cycle.id, superseded: false },
    orderBy: { timestamp: "asc" },
  });

  const previousCard = await prisma.diseaseCard.findFirst({
    where: { cycleId: cycle.id },
    orderBy: { version: "desc" },
    select: { version: true },
  });
  const cardData = generateDiseaseCard(cycle.disease, allObservations, user.nickname, previousCard?.version);
  const accessToken = crypto.randomBytes(32).toString("hex");
  const expiresAt = new Date(context.now.getTime() + 7 * 24 * 60 * 60 * 1000);
  const diseaseCardRecord = await prisma.diseaseCard.create({
    data: {
      userId: user.id,
      cycleId: cycle.id,
      disease: cardData.disease,
      version: cardData.version,
      modules: cardData.modules as unknown as Prisma.InputJsonValue,
      rawSummary: cardData.rawSummary,
      accessToken,
      expiresAt,
    },
  });

  // Generate or update a Brief for this cycle (30-day access token)
  const briefAccessToken = crypto.randomBytes(32).toString("hex");
  const briefExpiresAt = new Date(context.now.getTime() + 30 * 24 * 60 * 60 * 1000);
  const brief = await prisma.brief.upsert({
    where: { cycleId: cycle.id },
    update: {
      diseaseCardId: diseaseCardRecord.id,
      accessToken: briefAccessToken,
      expiresAt: briefExpiresAt,
    },
    create: {
      cycleId: cycle.id,
      diseaseCardId: diseaseCardRecord.id,
      webUrl: "",
      accessToken: briefAccessToken,
      expiresAt: briefExpiresAt,
    },
  });
  await prisma.brief.update({
    where: { id: brief.id },
    data: { webUrl: `/b/${brief.id}?t=${briefAccessToken}` },
  });

  const briefMessages: OutboundMessage[] = [];
  if (context.webBaseUrl) {
    const briefUrl = `${context.webBaseUrl}/b/${brief.id}?t=${briefAccessToken}`;
    const briefOutput: PlannerOutput = {
      reasoning: "Brief generated. Sending link to patient.",
      sessionObjective: "Share visit brief link with patient.",
      nextAction: {
        type: "generate_brief",
        topic: "brief_ready",
        purpose: "Your visit brief is ready.",
        budgetCost: 0,
      },
      safetyFlag: "none",
      updatePatientState: {},
    };
    const briefMessage = await renderMessage(userId, briefOutput, {
      style,
      locale: user.locale,
      cycleContext: { briefUrl },
    });
    const { messages: safeBriefMessages } = safetyWrapWithSummary(userId, [briefMessage]);
    await saveOutboundMessages(
      prisma,
      user.id,
      safeBriefMessages,
      cycle.id,
      new Date(),
      inboundEventId,
      traceId
    );
    briefMessages.push(...safeBriefMessages);
  }

  // For 4-week plans that have reached ~28 days, or 7-day trials that have
  // reached ~7 days, mark the cycle as COMPLETED.
  const cycleDay = Math.floor((context.now.getTime() - cycle.startedAt.getTime()) / (1000 * 60 * 60 * 24));
  if ((cycle.type === "PLAN_4_WEEK" && cycleDay >= 28) || (cycle.type === "TRIAL_7_DAY" && cycleDay >= 7)) {
    await prisma.cycle.update({
      where: { id: cycle.id },
      data: { status: "COMPLETED", endedAt: context.now },
    });
  } else {
    // Schedule the next check-in based on the user's A/B bucket (48h vs 72h) at 10:00 local time
    const nextCheckinAt = scheduleNextCheckInOffset(userId, context.now);
    await prisma.cycle.update({
      where: { id: cycle.id },
      data: { nextCheckinAt },
    });
  }

  return briefMessages;
}

export function isInsufficientExceptionAnswer(
  message: InboundMessage,
  answerEvaluation: AnswerConfidenceResult
): boolean {
  const text = (message.content.text ?? "").trim().toLowerCase();
  if (text.length < 5) return true;
  const vaguePatterns = [
    /don't know/i,
    /not sure/i,
    /no idea/i,
    /can't say/i,
    /unsure/i,
    /maybe/i,
  ];
  if (vaguePatterns.some((p) => p.test(text))) return true;
  if (answerEvaluation.matchMethod === "text" && answerEvaluation.confidence < 0.5) return true;
  return false;
}

function safetyWrapWithSummary(
  userId: string,
  messages: OutboundMessage[]
): { messages: OutboundMessage[]; summary: SafetyResult } {
  const results: SafetyResult[] = [];
  const wrapped = messages.map((msg) => {
    const check = safetyCheck(msg);
    results.push(check);
    if (!check.approved) {
      return {
        ...msg,
        content: {
          ...msg.content,
          text: "I'm not able to answer that in a safe way. Please speak to your healthcare team if you need advice.",
        },
      };
    }
    const addendums = check.requiredAddendums.filter((a) => !msg.content.text.includes(a));
    if (addendums.length > 0) {
      return {
        ...msg,
        content: {
          ...msg.content,
          text: `${msg.content.text}\n\n${addendums.join("\n\n")}`,
        },
      };
    }
    return msg;
  });

  return { messages: wrapped, summary: summarizeSafety(results) };
}

export async function handleInbound(
  context: EngineContext,
  message: InboundMessage
): Promise<OutboundMessage[]> {
  const result = await processInbound(context, message);
  return result.messages;
}

export async function processInbound(
  context: EngineContext,
  message: InboundMessage
): Promise<{ messages: OutboundMessage[]; trace: EngineTrace }> {
  const prisma = context.prisma;
  const userId = message.userId ?? message.channelId;
  let cycle: Cycle | null = null;

  // L1 Perception — audit callback defined after user resolution below

  // Resolve user/cycle context before perception so we can enforce per-user LLM quotas.
  let user = await prisma.user.findUnique({ where: { phoneNumber: userId } });
  cycle = user
    ? await prisma.cycle.findFirst({
        where: { userId: user.id, status: { in: ["ONBOARDING", "ACTIVE"] } },
        orderBy: { startedAt: "desc" },
      })
    : null;

  const auditLlmCall = async (
    model: string,
    input: unknown,
    output: string,
    tokenUsage?: { promptTokens?: number; completionTokens?: number; totalTokens?: number }
  ) => {
    await saveLlmCallEvent(prisma, user?.id ?? userId, cycle?.id, model, input, output, tokenUsage);
    await incrementLlmQuota(context.quotaStore, user?.id ?? userId, context.now);
  };

  const allowLlm = !user || (await hasLlmQuota(context.quotaStore, user.id, context.now));
  if (user && !allowLlm) {
    await saveLlmCallEvent(
      prisma,
      user.id,
      cycle?.id,
      "RULE_FALLBACK",
      { reason: "daily_llm_quota_exceeded" },
      "Falling back to rule-based logic for today.",
      { totalTokens: 0 }
    );
  }

  // Resolve check-in context before perception so L1 can use session awareness.
  let activeCheckIn = user && cycle
    ? await prisma.checkIn.findFirst({
        where: { cycleId: cycle.id, status: { in: ["SENT", "SCHEDULED"] } },
        orderBy: { scheduledAt: "desc" },
      })
    : null;

  const perceptionCtx = {
    checkInActive: activeCheckIn !== null,
    sessionObjective: activeCheckIn?.sessionObjective ?? undefined,
  } satisfies import("./types.js").PerceptionContext;

  const perception = await perceive(message, resolveLlmClient(context, "perception"), auditLlmCall, allowLlm, cycle?.disease ?? "asthma", perceptionCtx);

  // Onboarding initiation
  if (perception.intent.primary === "initiate" && !user) {
    user = await prisma.user.create({
      data: {
        phoneNumber: userId,
        timezone: "Europe/London",
        locale: "en-GB",
      },
    });
  }

  if (!user) {
    const outbound: import("@carememory/im-core").OutboundMessage[] = [
      {
        userId,
        conversationContext: { requiresSession: true, priority: "normal" },
        content: { type: "text" as const, text: "Welcome to CareMemory. Send START ASTHMA to begin." },
      },
    ];
    const { messages, summary } = safetyWrapWithSummary(userId, outbound);
    return {
      messages,
      trace: { perception, planner: emptyPlannerOutput(messages[0].content.text), safety: summary },
    };
  }

  if (!cycle && perception.intent.primary === "initiate") {
    cycle = await prisma.cycle.create({
      data: {
        userId: user.id,
        disease: "asthma",
        status: "ONBOARDING",
        startedAt: context.now,
      },
    });
  }

  if (!cycle) {
    // Cross-cycle late reply (B5): if the user has a previous cycle, ask whether the
    // message relates to it; if they confirm, store the observation on that cycle.
    const recentCycle = await prisma.cycle.findFirst({
      where: { userId: user.id },
      orderBy: { startedAt: "desc" },
    });

    if (perception.intent.primary === "confirm_recent_context" && recentCycle) {
      const inboundEventId = await saveInboundMessage(prisma, user.id, message, recentCycle.id);

      // The user is confirming that their previous message should be added to the most
      // recent cycle. Retrieve that previous inbound message from the event log so we
      // store the actual user content, not the "YES" confirmation itself.
      const previousInbound = await prisma.event.findFirst({
        where: {
          userId: user.id,
          type: "inbound_message",
          id: { not: inboundEventId },
        },
        orderBy: { timestamp: "desc" },
      });
      const previousText =
        previousInbound &&
        typeof previousInbound.payload === "object" &&
        previousInbound.payload !== null &&
        !Array.isArray(previousInbound.payload)
          ?
            (
              (previousInbound.payload as Record<string, unknown>).content as Record<string, unknown> | undefined
            )?.text ??
            (previousInbound.payload as Record<string, unknown>).text ??
            perception.rawText
          : perception.rawText;

      await saveObservations(
        prisma,
        user.id,
        recentCycle.id,
        inboundEventId,
        [
          {
            category: "subjective",
            concept: "free_text_response",
            value: previousText,
            attributes: { source: "cross_cycle_late_reply", originalTimestamp: previousInbound?.timestamp?.toISOString() },
            confidence: 1,
            extractedBy: "rule",
          },
        ],
        context.now
      );
      const { messages, summary } = safetyWrapWithSummary(userId, [
        {
          userId,
          conversationContext: { requiresSession: true, priority: "normal" },
          content: {
            type: "text" as const,
            text: "Thanks, I've added that to your recent record. Send START ASTHMA when you're ready for a new care cycle.",
          },
        },
      ]);
      await saveOutboundMessages(prisma, user.id, messages, recentCycle.id, new Date(), inboundEventId, perception.traceId, undefined);
      return {
        messages,
        trace: { perception, planner: emptyPlannerOutput(messages[0].content.text), safety: summary },
      };
    }

    if (recentCycle) {
      const outbound: import("@carememory/im-core").OutboundMessage[] = [
        {
          userId,
          conversationContext: { requiresSession: true, priority: "normal" },
          content: {
            type: "text" as const,
            text: "We couldn't find an active care cycle. Is this about your recent asthma record? Reply YES to add it, or send START ASTHMA to begin a new one.",
          },
        },
      ];
      const { messages, summary } = safetyWrapWithSummary(userId, outbound);
      return {
        messages,
        trace: { perception, planner: emptyPlannerOutput(messages[0].content.text), safety: summary },
      };
    }

    const outbound: import("@carememory/im-core").OutboundMessage[] = [
      {
        userId,
        conversationContext: { requiresSession: true, priority: "normal" },
        content: {
          type: "text" as const,
          text: "We couldn't find an active care cycle. Send START ASTHMA to begin a new one.",
        },
      },
    ];
    const { messages, summary } = safetyWrapWithSummary(userId, outbound);
    return {
      messages,
      trace: { perception, planner: emptyPlannerOutput(messages[0].content.text), safety: summary },
    };
  }

  // Handle account-level system commands
  if (perception.intent.primary === "delete_data") {
    await deleteUserData(prisma, user.id);
    const { messages, summary } = safetyWrapWithSummary(userId, [
      {
        userId,
        conversationContext: { requiresSession: true, priority: "normal" },
        content: {
          type: "text" as const,
          text: "Your account and all stored data have been deleted. If you need CareMemory again, send START ASTHMA.",
        },
      },
    ]);
    return {
      messages,
      trace: { perception, planner: emptyPlannerOutput(messages[0].content.text), safety: summary },
    };
  }

  if (perception.intent.primary === "export_data") {
    let outbound: OutboundMessage[];
    if (context.createExportToken && context.webBaseUrl) {
      const token = await context.createExportToken(user.id);
      const url = `${context.webBaseUrl}/api/export?t=${token}`;
      outbound = [
        {
          userId,
          conversationContext: { requiresSession: true, priority: "normal" },
          content: { type: "text" as const, text: `Here is your data export link. It is valid for 7 days:\n\n${url}` },
        },
      ];
    } else {
      outbound = [
        {
          userId,
          conversationContext: { requiresSession: true, priority: "normal" },
          content: { type: "text" as const, text: "We can't generate an export link right now. Please contact support." },
        },
      ];
    }
    const { messages, summary } = safetyWrapWithSummary(userId, outbound);
    return {
      messages,
      trace: { perception, planner: emptyPlannerOutput(messages[0].content.text), safety: summary },
    };
  }

  if (perception.intent.primary === "help") {
    const { pendingQuestion: pendingHelp } = activeCheckIn ? await getTurnState(prisma, activeCheckIn.id) : { pendingQuestion: null };
    if (!pendingHelp) {
      const { messages, summary } = safetyWrapWithSummary(userId, [
        {
          userId,
          conversationContext: { requiresSession: true, priority: "normal" },
          content: {
            type: "text" as const,
            text: "CareMemory helps you record your asthma between visits. Reply with:\n• START ASTHMA to begin\n• HELP for this message\n• EXPORT MY DATA for a copy of your data\n• DELETE MY DATA to delete your account\n• STOP to pause messages\n\nIf you're having severe breathing problems, call 999 or follow your asthma action plan.",
          },
        },
      ]);
      return {
        messages,
        trace: { perception, planner: emptyPlannerOutput(messages[0].content.text), safety: summary },
      };
    }
    // Fall through to Turn Manager when the user has an active pending question:
    // phrases like "I don't understand" should trigger a reprompt, not the help menu.
  }

  if (perception.intent.primary === "stop") {
    await prisma.cycle.update({
      where: { id: cycle.id },
      data: { status: "CANCELLED", endedAt: context.now },
    });
    const { messages, summary } = safetyWrapWithSummary(userId, [
      {
        userId,
        conversationContext: { requiresSession: true, priority: "normal" },
        content: {
          type: "text" as const,
          text: "We've paused your CareMemory reminders. Send START ASTHMA at any time to restart.",
        },
      },
    ]);
    return {
      messages,
      trace: { perception, planner: emptyPlannerOutput(messages[0].content.text), safety: summary },
    };
  }

  if (perception.intent.primary === "continue_cycle" && cycle.status === "ACTIVE") {
    await prisma.cycle.update({
      where: { id: cycle.id },
      data: { status: "COMPLETED", endedAt: context.now },
    });
    await prisma.cycle.create({
      data: {
        userId: user.id,
        disease: cycle.disease,
        type: "PLAN_4_WEEK",
        status: "ACTIVE",
        startedAt: context.now,
        nextCheckinAt: scheduleNextCheckInOffset(userId, context.now),
      },
    });
    const { messages, summary } = safetyWrapWithSummary(userId, [
      {
        userId,
        conversationContext: { requiresSession: true, priority: "normal" },
        content: {
          type: "text" as const,
          text: "Your next 4-week CareMemory cycle has started. I'll send your next check-in soon.",
        },
      },
    ]);
    return {
      messages,
      trace: { perception, planner: emptyPlannerOutput(messages[0].content.text), safety: summary },
    };
  }

  // Persist inbound message
  const inboundEventId = await saveInboundMessage(prisma, user.id, message, cycle.id, perception.traceId);
  await savePerceptionEvent(prisma, user.id, cycle.id, perception, perception.traceId);

  // Handle onboarding
  if (cycle.status === "ONBOARDING") {
    if (perception.intent.primary === "consent") {
      await prisma.user.update({
        where: { id: user.id },
        data: { consentGiven: true, consentAt: context.now, consentVersion: "v1" },
      });
      const { messages } = askNext(userId, { ...user, consentGiven: true });
      const { messages: safeMessages, summary } = safetyWrapWithSummary(userId, messages);
      await saveOutboundMessages(prisma, user.id, safeMessages, cycle.id, new Date(), inboundEventId, perception.traceId, undefined);
      if (perception.extractedObservations.length > 0) {
        await saveObservations(prisma, user.id, cycle.id, inboundEventId, perception.extractedObservations);
      }
      return {
        messages: safeMessages,
        trace: { perception, planner: emptyPlannerOutput(safeMessages[0]?.content.text ?? ""), safety: summary },
      };
    }

    // When the user sends "START ASTHMA" (intent=initiate) during onboarding, skip directly
    // to the consent prompt (or the next onboarding question if consent is already given).
    // This prevents "START ASTHMA" from being consumed as a nickname or other field value.
    if (perception.intent.primary === "initiate") {
      if (getPendingOnboardingField(user)) {
        const { messages } = askNext(userId, user);
        const { messages: safeMessages, summary } = safetyWrapWithSummary(userId, messages);
        await saveOutboundMessages(prisma, user.id, safeMessages, cycle.id, new Date(), inboundEventId, perception.traceId, undefined);
        if (perception.extractedObservations.length > 0) {
          await saveObservations(prisma, user.id, cycle.id, inboundEventId, perception.extractedObservations);
        }
        return {
          messages: safeMessages,
          trace: { perception, planner: emptyPlannerOutput(safeMessages[0]?.content.text ?? ""), safety: summary },
        };
      }
      // Fall through to the consent fallback below
    }

    const pending = getPendingOnboardingField(user);
    if (pending) {
      const { messages } = await handleOnboardingInput(prisma, user, cycle, perception.rawText, context.now);
      const { messages: safeMessages, summary } = safetyWrapWithSummary(userId, messages);
      await saveOutboundMessages(prisma, user.id, safeMessages, cycle.id, new Date(), inboundEventId, perception.traceId, undefined);
      if (perception.extractedObservations.length > 0) {
        await saveObservations(prisma, user.id, cycle.id, inboundEventId, perception.extractedObservations);
      }
      return {
        messages: safeMessages,
        trace: { perception, planner: emptyPlannerOutput(safeMessages[0]?.content.text ?? ""), safety: summary },
      };
    }

    // Fallback: show consent prompt
    if (perception.extractedObservations.length > 0) {
      await saveObservations(prisma, user.id, cycle.id, inboundEventId, perception.extractedObservations);
    }
    const { messages, summary } = safetyWrapWithSummary(userId, [
      {
        userId,
        conversationContext: { requiresSession: true, priority: "normal" },
        content: {
          type: "text" as const,
          text: "Hi, I'm CareMemory. I help you keep a light record of your asthma between appointments. This is not a diagnosis tool. Your data is only used to build your personal Disease Card and visit summary. Please review our privacy policy and reply AGREE to continue.",
        },
      },
    ]);
    return {
      messages,
      trace: { perception, planner: emptyPlannerOutput(messages[0].content.text), safety: summary },
    };
  }

  // L6 fast-path safety
  if (perception.safetyFlags.some((f) => f.riskLevel === "high")) {
    const { messages, summary } = safetyWrapWithSummary(userId, [
      {
        userId,
        conversationContext: { requiresSession: true, priority: "urgent" },
        content: {
          type: "text" as const,
          text: "I'm sorry you're struggling. If you're having severe breathing problems, call 999 or follow your asthma action plan now. Otherwise, tell me more about what's happening.",
        },
      },
    ]);
    if (perception.extractedObservations.length > 0) {
      await saveObservations(prisma, user.id, cycle.id, inboundEventId, perception.extractedObservations);
    }
    await saveOutboundMessages(prisma, user.id, messages, cycle.id, new Date(), inboundEventId, perception.traceId, activeCheckIn?.id);

    // Severe symptoms during an active check-in end the session immediately,
    // record an adverse event, and generate the Disease Card / Brief.
    if (activeCheckIn) {
      const severeFlag = perception.safetyFlags.find((f) => f.riskLevel === "high");
      await saveObservations(
        prisma,
        user.id,
        cycle.id,
        inboundEventId,
        [
          {
            category: "adverse_event",
            concept: "severe_safety_flag",
            value: severeFlag?.description ?? perception.rawText,
            attributes: { highRiskSafetyFlag: true, reason: severeFlag?.type },
            confidence: 1,
            extractedBy: "rule",
          },
        ],
        context.now
      );
      const style = (getBucket(userId, "conversation_style").variant as "v1" | "v2") ?? "v1";
      const briefMessages = await finalizeCheckInSession(
        context, user, cycle, activeCheckIn, inboundEventId, perception.traceId, style, "EXCEPTION"
      );
      messages.push(...briefMessages);
    }

    return {
      messages,
      trace: { perception, planner: emptyPlannerOutput(messages[0].content.text), safety: summary },
    };
  }

  // activeCheckIn was resolved before perception — reuse it here.
  // Late reply: if there is no active check-in but the cycle is still active, accept the update
  // instead of starting a new check-in. This satisfies the "late answer" boundary item.
  if (
    !activeCheckIn &&
    cycle.status === "ACTIVE" &&
    !["initiate", "consent", "skip", "confirm", "stop", "delete_data", "export_data", "help", "question"].includes(perception.intent.primary)
  ) {
    const { messages, summary } = safetyWrapWithSummary(userId, [
      {
        userId,
        conversationContext: { requiresSession: true, priority: "normal" },
        content: {
          type: "text" as const,
          text: "Thanks for the update. I've added it to your record and we'll pick it up in your next check-in.",
        },
      },
    ]);
    if (perception.extractedObservations.length > 0) {
      await saveObservations(prisma, user.id, cycle.id, inboundEventId, perception.extractedObservations);
    }
    await saveOutboundMessages(prisma, user.id, messages, cycle.id, new Date(), inboundEventId, perception.traceId, undefined);
    return {
      messages,
      trace: { perception, planner: emptyPlannerOutput(messages[0].content.text), safety: summary },
    };
  }

  // Save extracted observations, superseding previous values when the user is correcting themselves.
  // Scope observations to the active check-in so that each new check-in asks the control questions again.
  if (perception.extractedObservations.length > 0) {
    const observationIds = await saveObservations(
      prisma,
      user.id,
      cycle.id,
      inboundEventId,
      perception.extractedObservations,
      context.now
    );
    if (perception.intent.primary === "correction") {
      for (let i = 0; i < perception.extractedObservations.length; i++) {
        await supersedePreviousObservations(prisma, cycle.id, perception.extractedObservations[i].concept, observationIds[i]);
      }
    }
  }

  // Enter exception mode when the user reports an anomaly or medium-risk safety signal
  if (
    activeCheckIn &&
    !activeCheckIn.inExceptionMode &&
    (perception.anomalies.some((a) => a.severity === "medium" || a.severity === "high") ||
      perception.safetyFlags.some((f) => f.riskLevel === "medium"))
  ) {
    activeCheckIn = await prisma.checkIn.update({
      where: { id: activeCheckIn.id },
      data: { inExceptionMode: true, exceptionQuestionsAsked: 0, budgetRemaining: 3 },
    });

    // Record the concern as an adverse_event observation so it appears on the Disease Card.
    const concern =
      perception.anomalies.find((a) => a.severity === "medium" || a.severity === "high") ??
      perception.safetyFlags.find((f) => f.riskLevel === "medium");
    await saveObservations(
      prisma,
      user.id,
      cycle.id,
      inboundEventId,
      [
        {
          category: "adverse_event",
          concept: "exception_concern",
          value: concern?.description ?? perception.rawText,
          attributes: { exceptionConcern: true, clarified: false },
          confidence: 1,
          extractedBy: "rule",
        },
      ],
      context.now
    );
  }

  // L5 Turn Manager: if there is a pending question and the user did not answer it, reprompt.
  let preOutboundMessages: OutboundMessage[] = [];
  let topicShiftHandled = false;
  if (activeCheckIn) {
    const { pendingQuestion: pending, repromptCount } = await getTurnState(prisma, activeCheckIn.id);
    const answerEvaluation = pending
      ? evaluateAnswerToPendingQuestion(message, perception, pending, user.locale)
      : undefined;

    // Topic-shift detection: if the user volunteered info about a different
    // topic instead of answering the pending question, defer the pending
    // question and let L4 Planner handle the new observation.
    if (pending && answerEvaluation && !answerEvaluation.isAnswer) {
      const topicShift = detectTopicShift(message, perception, pending);
      if (topicShift.isShift) {
        await deferPendingQuestion(prisma, activeCheckIn.id, pending);
        await prisma.event.create({
          data: {
            userId: user.id,
            cycleId: cycle.id,
            checkInId: activeCheckIn.id,
            type: "user_action" as const,
            payload: {
              action: "topic_shift",
              fromTopic: pending.topic,
              toTopic: topicShift.shiftedToTopic,
              toObservations: topicShift.shiftedToObservations?.map((o) => o.concept),
            } as unknown as Prisma.InputJsonValue,
            timestamp: context.now,
            traceId: perception.traceId,
          },
        });
        topicShiftHandled = true;
      }
    }

    if (pending && answerEvaluation && !answerEvaluation.isAnswer && !topicShiftHandled) {
      const nextRepromptCount = repromptCount + 1;

      if (nextRepromptCount > getMaxReprompts()) {
        // Too many failed attempts: record a no-answer observation so the planner skips this topic,
        // then continue to the planner as usual.
        await saveObservations(
          prisma,
          user.id,
          cycle.id,
          inboundEventId,
          [
            {
              category: "subjective",
              concept: pending.topic,
              value: "no_answer",
              confidence: 1,
              extractedBy: "rule",
              attributes: { reason: "max_reprompts_exceeded" },
            },
          ],
          context.now
        );
        await clearPendingQuestion(prisma, activeCheckIn.id);
      } else {
          const conversationStyle = (getBucket(userId, "conversation_style").variant as "v1" | "v2") ?? "v1";
          const cycleDay = Math.floor((context.now.getTime() - cycle.startedAt.getTime()) / (1000 * 60 * 60 * 24));
          const renderOptions = {
            style: conversationStyle,
            locale: user.locale,
            cycleContext: { cycleType: cycle.type, cycleDay, briefReady: true },
            outOfSession: !isSessionOpen(user, context.now),
            templateResolver: context.templateResolver,
            templateContext: {
              nickname: user.nickname ?? undefined,
              firstName: user.nickname ?? undefined,
            },
          };

          // Clarification request: explain the question in simpler terms without
          // counting it as a failed reprompt attempt. Track repeated clarifications
          // so the system can rephrase, offer skip, and eventually move on.
          if (looksLikeClarificationRequest(perception.rawText)) {
            const clarificationCount = pending.clarificationCount ?? 0;

            if (clarificationCount >= 2) {
              // Too many clarifications: record no_answer, clear pending, and fall
              // through to L4 Planner so the check-in isn't stuck.
              await saveObservations(
                prisma,
                user.id,
                cycle.id,
                inboundEventId,
                [
                  {
                    category: "subjective" as const,
                    concept: pending.topic,
                    value: "no_answer" as Prisma.InputJsonValue,
                    confidence: 1,
                    extractedBy: "rule" as const,
                    attributes: { reason: "max_clarifications_exceeded" },
                  },
                ],
                context.now
              );
              await clearPendingQuestion(prisma, activeCheckIn.id);

              const moveOnMessage: OutboundMessage = {
                userId,
                conversationContext: { requiresSession: true, priority: "normal" },
                content: {
                  type: "text" as const,
                  text: "No problem — I'll move on to the next question. You can always come back to this later.",
                },
              };
              const { messages, summary } = safetyWrapWithSummary(userId, [moveOnMessage]);
              await saveOutboundMessages(prisma, user.id, messages, cycle.id, new Date(), inboundEventId, perception.traceId, activeCheckIn?.id);
              preOutboundMessages = messages;
              // Fall through to L4 Planner to ask the next question.
            } else {
              const clarification = await buildClarificationMessage(userId, pending, renderOptions, clarificationCount);

              const updatedPending: PendingQuestion = {
                ...pending,
                clarificationCount: clarificationCount + 1,
              };
              await prisma.checkIn.update({
                where: { id: activeCheckIn.id },
                data: {
                  pendingQuestion: updatedPending as unknown as Prisma.InputJsonValue,
                },
              });

              await prisma.event.create({
                data: {
                  userId: user.id,
                  cycleId: cycle.id,
                  checkInId: activeCheckIn.id,
                  type: "turn_reprompt" as const,
                  payload: {
                    topic: pending.topic,
                    action: "clarification",
                    clarificationCount: clarificationCount + 1,
                  } as unknown as Prisma.InputJsonValue,
                  timestamp: context.now,
                  traceId: perception.traceId,
                },
              });

              const { messages, summary } = safetyWrapWithSummary(userId, [clarification]);
              await saveOutboundMessages(prisma, user.id, messages, cycle.id, new Date(), inboundEventId, perception.traceId, activeCheckIn?.id);
              return {
                messages,
                trace: { perception, planner: emptyPlannerOutput(messages[0].content.text), safety: summary },
              };
            }
          } else if (looksLikeSkipRequest(perception.rawText)) {
            // Skip request: the user explicitly wants to skip this question.
            // Record a no_answer observation, clear the pending question, and let
            // the planner move on to the next topic.
            await recordSkippedQuestion(
              prisma,
              user.id,
              cycle.id,
              activeCheckIn.id,
              pending,
              inboundEventId,
              context.now,
              perception.traceId
            );
            // Fall through to L4 Planner so it can ask the next question.
          } else if (looksLikeGoBackRequest(perception.rawText)) {
            // Go back request: re-ask the previous question if there is one.
            const goBack = await goBackToPreviousQuestion(prisma, activeCheckIn.id);
            if (goBack.previousQuestion) {
              const previousQuestionMessage = await buildPreviousQuestionMessage(
                userId,
                goBack.previousQuestion,
                renderOptions
              );
              const { messages, summary } = safetyWrapWithSummary(userId, [previousQuestionMessage]);
              await saveOutboundMessages(prisma, user.id, messages, cycle.id, new Date(), inboundEventId, perception.traceId, activeCheckIn?.id);

              await prisma.event.create({
                data: {
                  userId: user.id,
                  cycleId: cycle.id,
                  checkInId: activeCheckIn.id,
                  type: "user_action" as const,
                  payload: {
                    action: "go_back",
                    topic: goBack.previousQuestion.topic,
                    expectedResponseType: goBack.previousQuestion.expectedResponseType,
                  } as unknown as Prisma.InputJsonValue,
                  timestamp: context.now,
                  traceId: perception.traceId,
                },
              });

              return {
                messages,
                trace: { perception, planner: emptyPlannerOutput(messages[0].content.text), safety: summary },
              };
            }
            // No history to go back to: fall through to L4 Planner, which will
            // re-ask the current question.
          } else {
            // Partial answer detection for multi_select: if the user named at
            // least one valid option but also included unknown meaningful words,
            // accept the valid options and ask them to clarify the rest. This
            // avoids treating a partially valid reply as a complete miss.
            if (pending.expectedResponseType === "multi_select") {
              const partial = detectPartialMultiSelectAnswer(message, pending, user.locale);
              if (partial.isPartial) {
                await saveObservations(
                  prisma,
                  user.id,
                  cycle.id,
                  inboundEventId,
                  partial.extracted.matched.map((optionId) => ({
                    category: "subjective" as const,
                    concept: pending.topic,
                    value: optionId,
                    confidence: Math.max(0.5, Math.min(0.95, partial.extracted.matched.length / (partial.extracted.matched.length + 1))),
                    extractedBy: "rule" as const,
                    attributes: { matchMethod: "partial" },
                  })),
                  context.now
                );

                const followUp = await buildPartialAnswerFollowUpMessage(
                  userId,
                  pending,
                  partial.extracted.matched,
                  partial.extracted.unmatched,
                  renderOptions
                );

                // Replace the pending question with a text follow-up so the
                // next reply is accepted as clarification.
                const followUpPending: PendingQuestion = {
                  topic: pending.topic,
                  purpose: followUp.content.text,
                  expectedResponseType: "text",
                  askedAt: new Date().toISOString(),
                };
                await prisma.checkIn.update({
                  where: { id: activeCheckIn.id },
                  data: {
                    pendingQuestion: followUpPending as unknown as Prisma.InputJsonValue,
                    repromptCount: 0,
                  },
                });

                await prisma.event.create({
                  data: {
                    userId: user.id,
                    cycleId: cycle.id,
                    checkInId: activeCheckIn.id,
                    type: "turn_reprompt" as const,
                    payload: {
                      topic: pending.topic,
                      action: "partial_answer_follow_up",
                      matched: partial.extracted.matched,
                      unmatched: partial.extracted.unmatched,
                    } as unknown as Prisma.InputJsonValue,
                    timestamp: context.now,
                    traceId: perception.traceId,
                  },
                });

                const { messages, summary } = safetyWrapWithSummary(userId, [followUp]);
                await saveOutboundMessages(prisma, user.id, messages, cycle.id, new Date(), inboundEventId, perception.traceId, activeCheckIn?.id);
                return {
                  messages,
                  trace: { perception, planner: emptyPlannerOutput(messages[0].content.text), safety: summary },
                };
              }
            }

            // Topic shift: the user did not answer the pending question but
            // introduced a new, relevant observation. Acknowledge it, record the
            // pending question as no_answer, and let L4 Planner continue with the
            // new context instead of reprompting.
            const topicShift = detectTopicShift(perception, pending, answerEvaluation);
            if (topicShift.isTopicShift) {
              await recordTopicShift(
                prisma,
                user.id,
                cycle.id,
                activeCheckIn.id,
                pending,
                topicShift.shiftedObservations,
                inboundEventId,
                context.now,
                perception.traceId
              );

              const acknowledgement = await buildTopicShiftAcknowledgementMessage(
                userId,
                pending,
                topicShift.shiftedObservations,
                renderOptions
              );
              const { messages: ackMessages } = safetyWrapWithSummary(userId, [acknowledgement]);
              await saveOutboundMessages(
                prisma,
                user.id,
                ackMessages,
                cycle.id,
                new Date(),
                inboundEventId,
                perception.traceId,
                activeCheckIn.id
              );
              preOutboundMessages = ackMessages;
              // Fall through to L4 Planner so it can ask the next question.
            } else {
              // Optional LLM fallback: if the LLM thinks the reply is actually an answer in natural language,
              // accept it and move on instead of reprompting. The LLM must meet a configurable confidence threshold.
              const dialogueLlmClient = resolveLlmClient(context, "dialogue");
              let acceptedByLlm = false;
              if (allowLlm && dialogueLlmClient) {
                const relevance = await isAnswerRelevantWithLlm(message, perception, pending, dialogueLlmClient, auditLlmCall);
                const threshold = getLlmAnswerRelevanceThreshold();
                if (relevance.isAnswer && relevance.confidence >= threshold) {
                  await saveObservations(
                    prisma,
                    user.id,
                    cycle.id,
                    inboundEventId,
                    [
                      {
                        category: "subjective",
                        concept: pending.topic,
                        value: message.content.text ?? "yes",
                        confidence: relevance.confidence,
                        extractedBy: "llm",
                        attributes: { matchMethod: "llm", llmReasoning: relevance.reasoning },
                      },
                    ],
                    context.now
                  );
                  await clearPendingQuestion(prisma, activeCheckIn.id);
                  acceptedByLlm = true;
                } else if (relevance.isAnswer) {
                  // LLM thought it was an answer but confidence was below threshold: log for analysis but still reprompt.
                  await prisma.event.create({
                    data: {
                      userId: user.id,
                      cycleId: cycle.id,
                      checkInId: activeCheckIn.id,
                      type: "turn_reprompt" as const,
                      payload: {
                        topic: pending.topic,
                        action: "llm_rejected_low_confidence",
                        confidence: relevance.confidence,
                        threshold,
                        reasoning: relevance.reasoning,
                      } as unknown as Prisma.InputJsonValue,
                      timestamp: context.now,
                      traceId: perception.traceId,
                    },
                  });
                }
              }

              if (!acceptedByLlm) {
                const reprompt = await buildRepromptMessage(userId, pending, nextRepromptCount, renderOptions);
                const { messages, summary } = safetyWrapWithSummary(userId, [reprompt]);
                await saveOutboundMessages(prisma, user.id, messages, cycle.id, new Date(), inboundEventId, perception.traceId, activeCheckIn?.id);
                await recordReprompt(
                  prisma,
                  user.id,
                  cycle.id,
                  activeCheckIn.id,
                  pending,
                  nextRepromptCount,
                  classifyNonAnswer(perception),
                  context.now,
                  perception.traceId
                );
                return {
                  messages,
                  trace: { perception, planner: emptyPlannerOutput(messages[0].content.text), safety: summary },
                };
              }
            }
          }
        }
    } else if (pending && answerEvaluation?.isAnswer && !topicShiftHandled) {
      // The user answered the pending question. Capture the match quality on the
      // inbound event for analytics, but do not rewrite perception observations here.
      await prisma.event.update({
        where: { id: inboundEventId },
        data: {
          payload: {
            ...perception,
            turnManager: {
              pendingTopic: pending.topic,
              matchConfidence: answerEvaluation.confidence,
              matchMethod: answerEvaluation.matchMethod,
            },
          } as unknown as Prisma.InputJsonValue,
        },
      });

      // Multi-turn exception mode: if the answer is vague or insufficient, reprompt
      // the same exception question before moving to the next one. This keeps the
      // user in the clarifying loop rather than accepting low-information replies.
      if (activeCheckIn.inExceptionMode && isInsufficientExceptionAnswer(message, answerEvaluation)) {
        const { repromptCount } = await getTurnState(prisma, activeCheckIn.id);
        if (repromptCount < getMaxReprompts()) {
          const conversationStyle = (getBucket(userId, "conversation_style").variant as "v1" | "v2") ?? "v1";
          const cycleDay = Math.floor((context.now.getTime() - cycle.startedAt.getTime()) / (1000 * 60 * 60 * 24));
          const renderOptions = {
            style: conversationStyle,
            locale: user.locale,
            cycleContext: { cycleType: cycle.type, cycleDay, briefReady: true },
            outOfSession: !isSessionOpen(user, context.now),
            templateResolver: context.templateResolver,
            templateContext: {
              nickname: user.nickname ?? undefined,
              firstName: user.nickname ?? undefined,
            },
          };
          const nextRepromptCount = repromptCount + 1;
          const reprompt = await buildRepromptMessage(userId, pending, nextRepromptCount, renderOptions);
          const { messages, summary } = safetyWrapWithSummary(userId, [reprompt]);
          await saveOutboundMessages(
            prisma,
            user.id,
            messages,
            cycle.id,
            new Date(),
            inboundEventId,
            perception.traceId,
            activeCheckIn.id
          );
          await recordReprompt(
            prisma,
            user.id,
            cycle.id,
            activeCheckIn.id,
            pending,
            nextRepromptCount,
            "insufficient_exception_answer",
            context.now,
            perception.traceId
          );
          return {
            messages,
            trace: { perception, planner: emptyPlannerOutput(messages[0].content.text), safety: summary },
          };
        }
        // If max reprompts reached in exception mode, fall through to the planner
        // so it moves on to the next exception question or ends the session.
      }
    }
  }

  // L4 Planner
  const latestNarrative = await prisma.narrativeSummary.findFirst({
    where: { cycleId: cycle.id },
    orderBy: { generatedAt: "desc" },
  });
  const recentObservations = await getRecentObservations(prisma, user.id, cycle.id, activeCheckIn?.sentAt ?? undefined);
  const plannerInput = {
    patientContext: {
      disease: cycle.disease,
      cycleId: cycle.id,
      cycleDay: Math.floor((context.now.getTime() - cycle.startedAt.getTime()) / (1000 * 60 * 60 * 24)),
      narrativeSummary: latestNarrative?.content ?? "",
      recentObservations,
      openIssues: [],
      medications: user.medications as unknown as MedicationBaseline | undefined,
    },
    conversationContext: {
      currentIntent: perception.intent.primary,
      intentStack: [],
      questionsAskedThisSession: activeCheckIn?.questionsAsked ?? 0,
      budgetRemaining: activeCheckIn?.budgetRemaining ?? 3,
      turnsRemaining: activeCheckIn ? activeCheckIn.turnBudget - activeCheckIn.turnCount : undefined,
      lastUserMessage: perception.rawText,
      inExceptionMode: activeCheckIn?.inExceptionMode ?? false,
      exceptionQuestionsAsked: activeCheckIn?.exceptionQuestionsAsked ?? 0,
      conversationStyle: getBucket(userId, "conversation_style").variant,
    },
    temporalContext: {
      localTime: context.now.toISOString(),
      dayOfWeek: context.now.toLocaleDateString("en-GB", { weekday: "long" }),
    },
  };

  let plannerOutput = await plan(plannerInput, resolveLlmClient(context, "planner"), auditLlmCall, allowLlm);
  await savePlannerEvent(prisma, user.id, cycle.id, plannerOutput, perception.traceId);

  // L5 session turn budget: if the planner still wants to ask but we have no
  // turns left, force a graceful end_session so the check-in cannot run forever.
  const turnsRemaining = activeCheckIn ? activeCheckIn.turnBudget - activeCheckIn.turnCount : undefined;
  if (
    activeCheckIn &&
    turnsRemaining !== undefined &&
    turnsRemaining <= 0 &&
    plannerOutput.nextAction.type !== "end_session"
  ) {
    plannerOutput = {
      reasoning: "Session turn budget exhausted; forcing end_session.",
      sessionObjective: "Close check-in after reaching the session turn limit.",
      nextAction: {
        type: "end_session",
        topic: "closing",
        purpose: "Thanks for your updates. Your Disease Card will be updated shortly.",
        budgetCost: 0,
      },
      safetyFlag: "none",
      updatePatientState: { updateNarrative: true },
    };
  }

  // L5 deferred question re-raise: if the planner is ready to close the session
  // but we still have budget and there are deferred questions from earlier
  // topic shifts, ask the oldest deferred question before closing.
  if (
    activeCheckIn &&
    plannerOutput.nextAction.type === "end_session" &&
    (turnsRemaining === undefined || turnsRemaining > 0)
  ) {
    const deferredQuestion = await popDeferredQuestion(prisma, activeCheckIn.id);
    if (deferredQuestion) {
      plannerOutput = {
        reasoning: "Re-raising a deferred question before closing the session.",
        sessionObjective: deferredQuestion.purpose,
        nextAction: {
          type: "ask",
          topic: deferredQuestion.topic,
          purpose: `Before we finish: ${deferredQuestion.purpose}`,
          expectedResponseType: deferredQuestion.expectedResponseType,
          options: deferredQuestion.options,
          budgetCost: 0,
        },
        safetyFlag: "none",
        updatePatientState: {},
      };
    }
  }

  // L5 Dialogue
  const cycleDay = Math.floor((context.now.getTime() - cycle.startedAt.getTime()) / (1000 * 60 * 60 * 24));
  let dialogueTrace: import("./types.js").DialogueTrace | undefined;
  let outbound: OutboundMessage;
  try {
    outbound = await renderMessage(userId, plannerOutput, {
    style: (plannerInput.conversationContext.conversationStyle as "v1" | "v2") ?? "v1",
    locale: user.locale,
    cycleContext: {
      cycleType: cycle.type,
      cycleDay,
      briefReady: true,
    },
    outOfSession: !isSessionOpen(user, context.now),
    templateResolver: context.templateResolver,
    templateContext: {
      nickname: user.nickname ?? undefined,
      firstName: user.nickname ?? undefined,
    },
    onRenderTrace: (trace) => {
      dialogueTrace = trace;
    },
  });
  } catch (err) {
    console.error("L5 render failed, falling back to safe message", {
      userId,
      cycleId: cycle.id,
      nextAction: plannerOutput.nextAction,
      error: err instanceof Error ? err.message : String(err),
    });
    outbound = {
      userId,
      conversationContext: { requiresSession: true, priority: "normal" },
      content: {
        type: "text",
        text: "I'm sorry, I couldn't prepare a reply right now. Please try again or contact your healthcare team if you need help.",
      },
    };
  }

  // Update check-in budget if active
  if (activeCheckIn && plannerOutput.nextAction.budgetCost > 0) {
    const updateData: Parameters<typeof prisma.checkIn.update>[0]["data"] = {
      questionsAsked: { increment: 1 },
      budgetRemaining: { decrement: plannerOutput.nextAction.budgetCost },
    };
    if (activeCheckIn.inExceptionMode) {
      updateData.exceptionQuestionsAsked = { increment: 1 };
    }
    await prisma.checkIn.update({
      where: { id: activeCheckIn.id },
      data: updateData,
    });
  }

  const { messages, summary } = safetyWrapWithSummary(userId, [outbound]);
  await saveOutboundMessages(
    prisma,
    user.id,
    messages,
    cycle.id,
    new Date(),
    inboundEventId,
    perception.traceId,
    activeCheckIn?.id
  );

  // Prepend any messages that were already sent from Turn Manager before
  // falling through to L4 Planner (e.g. multi-turn clarification move-on).
  messages.unshift(...preOutboundMessages);

  // Persist the pending question (or clear it) on the active check-in for TurnManager.
  if (activeCheckIn) {
    const pending = pendingQuestionFromPlannerOutput(plannerOutput);
    if (pending) {
      await setPendingQuestion(prisma, activeCheckIn.id, pending);
    } else {
      await clearPendingQuestion(prisma, activeCheckIn.id);
    }
  }

  // Generate Disease Card and schedule next check-in when session ends
  if (plannerOutput.nextAction.type === "end_session" && activeCheckIn) {
    const style = (plannerInput.conversationContext.conversationStyle as "v1" | "v2") ?? "v1";
    const briefMessages = await finalizeCheckInSession(
      context,
      user,
      cycle,
      activeCheckIn,
      inboundEventId,
      perception.traceId,
      style,
      activeCheckIn.inExceptionMode ? "EXCEPTION" : "COMPLETED"
    );
    messages.push(...briefMessages);
  }

  return {
    messages,
    trace: { perception, planner: plannerOutput, dialogue: dialogueTrace, safety: summary },
  };
}

export async function handleCheckInTrigger(
  context: EngineContext,
  cycleId: string
): Promise<OutboundMessage[]> {
  const prisma = context.prisma;
  const cycle = await prisma.cycle.findUnique({
    where: { id: cycleId },
    include: { user: true },
  });

  if (!cycle || cycle.status !== "ACTIVE") return [];

  const auditLlmCall = async (
    model: string,
    input: unknown,
    output: string,
    tokenUsage?: { promptTokens?: number; completionTokens?: number; totalTokens?: number }
  ) => {
    await saveLlmCallEvent(prisma, cycle.userId, cycle.id, model, input, output, tokenUsage);
    await incrementLlmQuota(context.quotaStore, cycle.userId, context.now);
  };

  const allowLlm = await hasLlmQuota(context.quotaStore, cycle.userId, context.now);

  // Do not create a new check-in if one is already active/unsanswered for this cycle.
  const existingActiveCheckIn = await prisma.checkIn.findFirst({
    where: { cycleId: cycle.id, status: { in: ["SENT", "SCHEDULED"] } },
  });
  if (existingActiveCheckIn) {
    return [];
  }

  const baseBudget = hasControllerMedication(cycle.user.medications as unknown as MedicationBaseline | undefined) ? 4 : 3;
  const turnBudget = getSessionTurnBudget();

  // Create check-in as SCHEDULED first, then update to SENT after messages are sent
  const checkIn = await prisma.checkIn.create({
    data: {
      cycleId: cycle.id,
      scheduledAt: context.now,
      status: "SCHEDULED",
      budgetRemaining: baseBudget,
      turnBudget,
    },
  });
  await prisma.event.create({
    data: {
      userId: cycle.userId,
      cycleId: cycle.id,
      checkInId: checkIn.id,
      type: "checkin_scheduled",
      payload: { scheduledAt: context.now.toISOString() },
      timestamp: context.now,
    },
  });

  const recentObservations = await getRecentObservations(prisma, cycle.userId, cycle.id, checkIn.scheduledAt ?? undefined);

  const cycleNarrative = await prisma.narrativeSummary.findFirst({
    where: { cycleId: cycle.id },
    orderBy: { generatedAt: "desc" },
  });

  const plannerInput = {
    patientContext: {
      disease: cycle.disease,
      cycleId: cycle.id,
      cycleDay: Math.floor((context.now.getTime() - cycle.startedAt.getTime()) / (1000 * 60 * 60 * 24)),
      narrativeSummary: cycleNarrative?.content ?? "",
      recentObservations,
      openIssues: [],
      medications: cycle.user.medications as unknown as MedicationBaseline | undefined,
    },
    conversationContext: {
      currentIntent: "checkin_start" as const,
      intentStack: [],
      questionsAskedThisSession: 0,
      budgetRemaining: baseBudget,
      turnsRemaining: turnBudget,
      inExceptionMode: false,
      exceptionQuestionsAsked: 0,
      conversationStyle: getBucket(cycle.user.phoneNumber, "conversation_style").variant,
    },
    temporalContext: {
      localTime: context.now.toISOString(),
      dayOfWeek: context.now.toLocaleDateString("en-GB", { weekday: "long" }),
    },
  };

  const plannerOutput = await plan(plannerInput, resolveLlmClient(context, "planner"), auditLlmCall, allowLlm);
  await savePlannerEvent(prisma, cycle.userId, cycle.id, plannerOutput);

  let outbound: OutboundMessage;
  try {
    outbound = await renderMessage(cycle.user.phoneNumber, plannerOutput, {
      style: (plannerInput.conversationContext.conversationStyle as "v1" | "v2") ?? "v1",
      locale: cycle.user.locale,
      cycleContext: {
        cycleType: cycle.type,
        cycleDay: plannerInput.patientContext.cycleDay,
        briefReady: true,
      },
      outOfSession: !isSessionOpen(cycle.user, context.now),
      templateResolver: context.templateResolver,
      templateContext: {
        nickname: cycle.user.nickname ?? undefined,
        firstName: cycle.user.nickname ?? undefined,
      },
    });
  } catch (err) {
    console.error("L5 render failed in handleCheckInTrigger, falling back to safe message", {
      userId: cycle.user.phoneNumber,
      cycleId: cycle.id,
      nextAction: plannerOutput.nextAction,
      error: err instanceof Error ? err.message : String(err),
    });
    outbound = {
      userId: cycle.user.phoneNumber,
      conversationContext: { requiresSession: true, priority: "normal" },
      content: {
        type: "text",
        text: "I'm sorry, I couldn't prepare your check-in right now. Please send START ASTHMA when you're ready to try again.",
      },
    };
  }
  const { messages, summary } = safetyWrapWithSummary(cycle.user.phoneNumber, [outbound]);
  await saveOutboundMessages(
    prisma,
    cycle.userId,
    messages,
    cycle.id,
    new Date(),
    checkIn.id,
    undefined,
    checkIn.id
  );

  const pending = pendingQuestionFromPlannerOutput(plannerOutput);
  if (pending) {
    await setPendingQuestion(prisma, checkIn.id, pending);
  }

  // Mark check-in as SENT now that messages have been sent
  await prisma.checkIn.update({
    where: { id: checkIn.id },
    data: { status: "SENT", sentAt: context.now },
  });
  await prisma.event.create({
    data: {
      userId: cycle.userId,
      cycleId: cycle.id,
      checkInId: checkIn.id,
      type: "checkin_sent",
      payload: { sentAt: context.now.toISOString() },
      timestamp: context.now,
    },
  });

  await prisma.checkIn.update({
    where: { id: checkIn.id },
    data: {
      questionsAsked: { increment: 1 },
      budgetRemaining: { decrement: plannerOutput.nextAction.budgetCost },
    },
  });

  // Schedule the next check-in so the scheduler/test tool knows when the following one is due.
  const nextCheckinAt = scheduleNextCheckInOffset(cycle.userId, context.now);
  await prisma.cycle.update({
    where: { id: cycle.id },
    data: { nextCheckinAt },
  });

  return messages;
}
