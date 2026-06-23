import type { InboundMessage, OutboundMessage } from "@carememory/im-core";
import { generateDiseaseCard } from "@carememory/disease-card";
import { Prisma } from "@carememory/db";
import type { Cycle } from "@carememory/db";
import crypto from "node:crypto";
import type { EngineContext, EngineTrace, LlmModelType, PlannerOutput, SafetyResult } from "./types.js";
import { perceive } from "./perception.js";
import { safetyCheck } from "./safety.js";
import { plan } from "./planner.js";
import { renderMessage } from "./dialogue.js";
import type { LLMClient } from "./llm.js";
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
} from "./memory.js";
import { getPendingOnboardingField, handleOnboardingInput, askNext } from "./onboarding.js";

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

function resolveLlmClient(context: EngineContext, model: LlmModelType): LLMClient | undefined {
  return context.llmClientFor?.(model) ?? context.llmClient;
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

  // L1 Perception
  const auditLlmCall = async (
    model: string,
    input: unknown,
    output: string,
    tokenUsage?: { prompt?: number; completion?: number; total?: number }
  ) => {
    await saveLlmCallEvent(prisma, userId, cycle?.id, model, input, output, tokenUsage);
    await incrementLlmQuota(context.quotaStore, userId, context.now);
  };

  // Resolve user/cycle context before perception so we can enforce per-user LLM quotas.
  let user = await prisma.user.findUnique({ where: { phoneNumber: userId } });
  cycle = user
    ? await prisma.cycle.findFirst({
        where: { userId: user.id, status: { in: ["ONBOARDING", "ACTIVE"] } },
        orderBy: { startedAt: "desc" },
      })
    : null;

  const allowLlm = !user || (await hasLlmQuota(context.quotaStore, user.id, context.now));
  if (user && !allowLlm) {
    await saveLlmCallEvent(
      prisma,
      user.id,
      cycle?.id,
      "RULE_FALLBACK",
      { reason: "daily_llm_quota_exceeded" },
      "Falling back to rule-based logic for today.",
      { total: 0 }
    );
  }

  const perception = await perceive(message, resolveLlmClient(context, "perception"), auditLlmCall, allowLlm);

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
      await saveOutboundMessages(prisma, user.id, messages, recentCycle.id, context.now, inboundEventId);
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
  const inboundEventId = await saveInboundMessage(prisma, user.id, message, cycle.id);
  await savePerceptionEvent(prisma, user.id, cycle.id, perception);

  // Handle onboarding
  if (cycle.status === "ONBOARDING") {
    if (perception.intent.primary === "consent") {
      await prisma.user.update({
        where: { id: user.id },
        data: { consentGiven: true, consentAt: context.now, consentVersion: "v1" },
      });
      const { messages } = askNext(userId, { ...user, consentGiven: true });
      const { messages: safeMessages, summary } = safetyWrapWithSummary(userId, messages);
      await saveOutboundMessages(prisma, user.id, safeMessages, cycle.id, context.now, inboundEventId);
      return {
        messages: safeMessages,
        trace: { perception, planner: emptyPlannerOutput(safeMessages[0]?.content.text ?? ""), safety: summary },
      };
    }

    const pending = getPendingOnboardingField(user);
    if (pending) {
      const { messages } = await handleOnboardingInput(prisma, user, cycle, perception.rawText, context.now);
      const { messages: safeMessages, summary } = safetyWrapWithSummary(userId, messages);
      await saveOutboundMessages(prisma, user.id, safeMessages, cycle.id, context.now, inboundEventId);
      return {
        messages: safeMessages,
        trace: { perception, planner: emptyPlannerOutput(safeMessages[0]?.content.text ?? ""), safety: summary },
      };
    }

    // Fallback: show consent prompt
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
    return {
      messages,
      trace: { perception, planner: emptyPlannerOutput(messages[0].content.text), safety: summary },
    };
  }

  // Resolve active check-in
  let activeCheckIn = await prisma.checkIn.findFirst({
    where: { cycleId: cycle.id, status: { in: ["SENT", "SCHEDULED"] } },
    orderBy: { scheduledAt: "desc" },
  });

  // Late reply: if there is no active check-in but the cycle is still active, accept the update
  // instead of starting a new check-in. This satisfies the "late answer" boundary item.
  if (
    !activeCheckIn &&
    cycle.status === "ACTIVE" &&
    !["initiate", "consent", "skip", "confirm", "stop", "delete_data", "export_data", "help"].includes(perception.intent.primary)
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
    await saveOutboundMessages(prisma, user.id, messages, cycle.id, context.now, inboundEventId);
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

  const recentObservations = await getRecentObservations(prisma, user.id, cycle.id, activeCheckIn?.sentAt ?? undefined);

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

  // L4 Planner
  const plannerInput = {
    patientContext: {
      disease: cycle.disease,
      cycleId: cycle.id,
      cycleDay: Math.floor((context.now.getTime() - cycle.startedAt.getTime()) / (1000 * 60 * 60 * 24)),
      narrativeSummary: "",
      recentObservations,
      openIssues: [],
    },
    conversationContext: {
      currentIntent: perception.intent.primary,
      intentStack: [],
      questionsAskedThisSession: activeCheckIn?.questionsAsked ?? 0,
      budgetRemaining: activeCheckIn?.budgetRemaining ?? 3,
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

  const plannerOutput = await plan(plannerInput, resolveLlmClient(context, "planner"), auditLlmCall, allowLlm);
  await savePlannerEvent(prisma, user.id, cycle.id, plannerOutput);

  // L5 Dialogue
  const outbound = renderMessage(userId, plannerOutput);

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
  await saveOutboundMessages(prisma, user.id, messages, cycle.id, context.now, inboundEventId);

  // Generate Disease Card and schedule next check-in when session ends
  if (plannerOutput.nextAction.type === "end_session" && activeCheckIn) {
    await prisma.checkIn.update({
      where: { id: activeCheckIn.id },
      data: {
        status: activeCheckIn.inExceptionMode ? "EXCEPTION" : "COMPLETED",
        completedAt: context.now,
      },
    });

    const allObservations = await prisma.observation.findMany({
      where: { cycleId: cycle.id },
      orderBy: { timestamp: "asc" },
    });

    const cardData = generateDiseaseCard(cycle.disease, allObservations, user.nickname);
    const accessToken = crypto.randomBytes(32).toString("hex");
    const expiresAt = new Date(context.now.getTime() + 7 * 24 * 60 * 60 * 1000);
    await prisma.diseaseCard.create({
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

    // For 4-week plans that have reached ~28 days, prompt the user to continue rather than scheduling another check-in on this cycle.
    const cycleDay = Math.floor((context.now.getTime() - cycle.startedAt.getTime()) / (1000 * 60 * 60 * 24));
    if (cycle.type === "PLAN_4_WEEK" && cycleDay >= 28) {
      await prisma.cycle.update({
        where: { id: cycle.id },
        data: { status: "COMPLETED", endedAt: context.now },
      });
      if (messages[0]?.content.type === "text") {
        messages[0].content.text =
          "You've reached the end of your 4-week CareMemory plan. Reply CONTINUE to start your next 4-week cycle, or STOP to pause.";
      }
    } else {
      // Schedule the next check-in based on the user's A/B bucket (48h vs 72h) at 10:00 local time
      const nextCheckinAt = scheduleNextCheckInOffset(userId, context.now);
      await prisma.cycle.update({
        where: { id: cycle.id },
        data: { nextCheckinAt },
      });
    }
  }

  return {
    messages,
    trace: { perception, planner: plannerOutput, safety: summary },
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
    tokenUsage?: { prompt?: number; completion?: number; total?: number }
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

  const checkIn = await prisma.checkIn.create({
    data: {
      cycleId: cycle.id,
      scheduledAt: context.now,
      sentAt: context.now,
      status: "SENT",
      budgetRemaining: 3,
    },
  });

  const recentObservations = await getRecentObservations(prisma, cycle.userId, cycle.id, checkIn.sentAt ?? undefined);

  const plannerInput = {
    patientContext: {
      disease: cycle.disease,
      cycleId: cycle.id,
      cycleDay: Math.floor((context.now.getTime() - cycle.startedAt.getTime()) / (1000 * 60 * 60 * 24)),
      narrativeSummary: "",
      recentObservations,
      openIssues: [],
    },
    conversationContext: {
      currentIntent: "checkin_start" as const,
      intentStack: [],
      questionsAskedThisSession: 0,
      budgetRemaining: 3,
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

  const outbound = renderMessage(cycle.user.phoneNumber, plannerOutput);
  const { messages, summary } = safetyWrapWithSummary(cycle.user.phoneNumber, [outbound]);
  await saveOutboundMessages(prisma, cycle.userId, messages, cycle.id, context.now, checkIn.id);

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
