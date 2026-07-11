import type { InboundMessage, OutboundMessage } from "@carememory/im-core";
import { Prisma, type PrismaClient } from "@carememory/db";
import type { PlannerOutput, PerceptionResult } from "./types.js";
import { renderMessage, type RenderOptions } from "./dialogue.js";

export interface PendingQuestion {
  topic: string;
  purpose: string;
  expectedResponseType: "single_choice" | "scale" | "multi_select" | "text";
  options?: string[];
  askedAt: string;
}

export interface TurnState {
  pendingQuestion?: PendingQuestion;
  repromptCount: number;
}

/** Maximum number of reprompts before the system gives up and moves on. */
export const MAX_REPROMPTS = 2;

export function pendingQuestionFromPlannerOutput(output: PlannerOutput): PendingQuestion | undefined {
  const action = output.nextAction;
  if (action.type !== "ask") return undefined;
  if (!action.expectedResponseType) return undefined;
  return {
    topic: action.topic,
    purpose: action.purpose,
    expectedResponseType: action.expectedResponseType,
    options: action.options,
    askedAt: new Date().toISOString(),
  };
}

export async function getTurnState(prisma: PrismaClient, checkInId: string): Promise<TurnState> {
  const checkIn = await prisma.checkIn.findUnique({
    where: { id: checkInId },
    select: { pendingQuestion: true, repromptCount: true },
  });
  return {
    pendingQuestion: (checkIn?.pendingQuestion as PendingQuestion | undefined) ?? undefined,
    repromptCount: checkIn?.repromptCount ?? 0,
  };
}

export function isAnswerToPendingQuestion(
  message: InboundMessage,
  perception: PerceptionResult,
  pending: PendingQuestion
): boolean {
  const nonAnswerIntents = new Set([
    "question",
    "help",
    "stop",
    "delete_data",
    "export_data",
    "continue_cycle",
    "initiate",
    "correction",
  ]);
  if (nonAnswerIntents.has(perception.intent.primary)) return false;

  if (pending.expectedResponseType === "text") return true;

  const options = pending.options ?? [];
  const optionSet = new Set(options.map((o) => o.toLowerCase()));

  if (message.content.type === "button_reply" && message.content.buttonId) {
    return optionSet.has(message.content.buttonId.toLowerCase());
  }

  if (message.content.type === "list_reply" && message.content.listId) {
    return optionSet.has(message.content.listId.toLowerCase());
  }

  const text = (message.content.text ?? "").trim().toLowerCase();
  if (pending.expectedResponseType === "scale") {
    return /^[1-5]$/.test(text);
  }

  if (pending.expectedResponseType === "single_choice") {
    if (optionSet.has(text)) return true;
  }

  if (pending.expectedResponseType === "multi_select") {
    const tokens = text.split(/[,\s]+/).filter(Boolean);
    return tokens.length > 0 && tokens.every((t) => optionSet.has(t));
  }

  // Accept free-text replies when perception extracted an observation for the pending topic.
  if (perception.extractedObservations.some((o) => o.concept === pending.topic)) {
    return true;
  }

  return false;
}

export function classifyNonAnswer(perception: PerceptionResult): string {
  const nonAnswerIntents = new Set([
    "question",
    "help",
    "stop",
    "delete_data",
    "export_data",
    "continue_cycle",
    "initiate",
    "correction",
  ]);
  if (nonAnswerIntents.has(perception.intent.primary)) {
    return `intent_${perception.intent.primary}`;
  }
  return "option_mismatch";
}

function repromptPrefix(repromptCount: number): string {
  if (repromptCount <= 1) return "I didn't catch that. ";
  if (repromptCount === 2) return "Just to confirm: ";
  return "Still waiting: ";
}

export async function buildRepromptMessage(
  userId: string,
  pending: PendingQuestion,
  repromptCount: number,
  options: RenderOptions
): Promise<OutboundMessage> {
  const repromptOutput: PlannerOutput = {
    reasoning: "Reprompting pending question because the user's reply did not answer it.",
    sessionObjective: pending.purpose,
    nextAction: {
      type: "ask",
      topic: pending.topic,
      purpose: `${repromptPrefix(repromptCount)}${pending.purpose}`,
      expectedResponseType: pending.expectedResponseType,
      options: pending.options,
      budgetCost: 0,
    },
    safetyFlag: "none",
    updatePatientState: {},
  };

  return renderMessage(userId, repromptOutput, options);
}

export async function recordReprompt(
  prisma: PrismaClient,
  userId: string,
  cycleId: string,
  checkInId: string,
  pending: PendingQuestion,
  repromptCount: number,
  reason: string,
  now: Date,
  traceId?: string
): Promise<void> {
  await prisma.checkIn.update({
    where: { id: checkInId },
    data: {
      repromptCount,
      pendingQuestion: pending as unknown as Prisma.InputJsonValue,
    },
  });

  await prisma.event.create({
    data: {
      userId,
      cycleId,
      checkInId,
      type: "turn_reprompt" as const,
      payload: {
        topic: pending.topic,
        expectedResponseType: pending.expectedResponseType,
        repromptCount,
        reason,
      } as unknown as Prisma.InputJsonValue,
      timestamp: now,
      traceId,
    },
  });
}

export async function clearPendingQuestion(prisma: PrismaClient, checkInId: string): Promise<void> {
  await prisma.checkIn.update({
    where: { id: checkInId },
    data: {
      pendingQuestion: Prisma.JsonNull,
      repromptCount: 0,
    },
  });
}

export async function setPendingQuestion(
  prisma: PrismaClient,
  checkInId: string,
  pending: PendingQuestion
): Promise<void> {
  await prisma.checkIn.update({
    where: { id: checkInId },
    data: {
      pendingQuestion: pending as unknown as Prisma.InputJsonValue,
      repromptCount: 0,
    },
  });
}
