import type { InboundMessage, OutboundMessage } from "@carememory/im-core";
import type { PlannerOutput, PerceptionResult } from "./types.js";
import { renderMessage, type RenderOptions } from "./dialogue.js";
import type { PrismaClient } from "@carememory/db";

export interface PendingQuestion {
  topic: string;
  purpose: string;
  expectedResponseType: "single_choice" | "scale" | "multi_select" | "text";
  options?: string[];
  askedAt: string;
}

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

export async function getPendingQuestion(
  prisma: PrismaClient,
  checkInId: string
): Promise<PendingQuestion | undefined> {
  const event = await prisma.event.findFirst({
    where: { checkInId, type: "outbound_message" },
    orderBy: { timestamp: "desc" },
  });
  if (!event || typeof event.payload !== "object" || event.payload === null || Array.isArray(event.payload)) {
    return undefined;
  }
  const pending = (event.payload as Record<string, unknown>)._pendingQuestion;
  if (!pending || typeof pending !== "object") return undefined;
  return pending as PendingQuestion;
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

export async function buildRepromptMessage(
  userId: string,
  pending: PendingQuestion,
  options: RenderOptions
): Promise<OutboundMessage> {
  const repromptOutput: PlannerOutput = {
    reasoning: "Reprompting pending question because the user's reply did not answer it.",
    sessionObjective: pending.purpose,
    nextAction: {
      type: "ask",
      topic: pending.topic,
      purpose: `I didn't catch that. ${pending.purpose}`,
      expectedResponseType: pending.expectedResponseType,
      options: pending.options,
      budgetCost: 0,
    },
    safetyFlag: "none",
    updatePatientState: {},
  };

  return renderMessage(userId, repromptOutput, options);
}
