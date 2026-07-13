import type { InboundMessage, OutboundMessage } from "@carememory/im-core";
import { Prisma, type PrismaClient, type ObservationCategory } from "@carememory/db";
import type { Observation, PlannerOutput, PerceptionResult } from "./types.js";
import { renderMessage, type RenderOptions } from "./dialogue.js";
import { matchOptionSynonym, matchScaleWord, getLocale, type DialogueLocale } from "./dialogue-locales/index.js";
import type { LLMClient, LLMMessage } from "./llm.js";
import type { LlmAuditCallback } from "./perception.js";

export interface PendingQuestion {
  topic: string;
  purpose: string;
  expectedResponseType: "single_choice" | "scale" | "multi_select" | "text";
  options?: string[];
  askedAt: string;
  /** Number of clarification messages already sent for this pending question. */
  clarificationCount?: number;
}

export interface TurnState {
  pendingQuestion?: PendingQuestion;
  repromptCount: number;
  questionHistory: PendingQuestion[];
}

/** Default maximum number of reprompts before the system gives up and moves on. */
export const DEFAULT_MAX_REPROMPTS = 2;

function parseIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (Number.isNaN(parsed) || parsed < 0 || !Number.isInteger(parsed)) {
    console.warn(`[turn-manager] Invalid ${name}="${raw}"; using fallback ${fallback}`);
    return fallback;
  }
  return parsed;
}

/** Maximum number of reprompts; configurable via PENDING_QUESTION_MAX_REPROMPTS. */
export function getMaxReprompts(): number {
  return parseIntEnv("PENDING_QUESTION_MAX_REPROMPTS", DEFAULT_MAX_REPROMPTS);
}

/** Default session-level turn budget (system outbound turns per check-in). */
export const DEFAULT_SESSION_TURN_BUDGET = 12;

/** Session turn budget; configurable via SESSION_TURN_BUDGET. */
export function getSessionTurnBudget(): number {
  return parseIntEnv("SESSION_TURN_BUDGET", DEFAULT_SESSION_TURN_BUDGET);
}

/** @deprecated Use {@link getMaxReprompts} instead. */
export const MAX_REPROMPTS = DEFAULT_MAX_REPROMPTS;

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
    select: { pendingQuestion: true, repromptCount: true, questionHistory: true },
  });
  return {
    pendingQuestion: (checkIn?.pendingQuestion as PendingQuestion | undefined) ?? undefined,
    repromptCount: checkIn?.repromptCount ?? 0,
    questionHistory: (checkIn?.questionHistory as PendingQuestion[] | undefined) ?? [],
  };
}


export interface LlmRelevanceResult {
  isAnswer: boolean;
  /** Confidence in [0, 1] that the reply actually answers the pending question. */
  confidence: number;
  /** Natural language explanation, not shown to the user. */
  reasoning?: string;
}

function parseFloatEnv(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (Number.isNaN(parsed) || parsed < min || parsed > max) {
    console.warn(`[turn-manager] Invalid ${name}="${raw}"; using fallback ${fallback}`);
    return fallback;
  }
  return parsed;
}

/** Minimum LLM confidence required to accept a free-text reply as an answer. */
export function getLlmAnswerRelevanceThreshold(): number {
  return parseFloatEnv("LLM_ANSWER_RELEVANCE_THRESHOLD", 0.7, 0, 1);
}

export interface AnswerConfidenceResult {
  /** Whether the reply answers the pending question. */
  isAnswer: boolean;
  /** Confidence score in [0, 1]. */
  confidence: number;
  /** How the answer was matched. */
  matchMethod:
    | "exact_option"
    | "synonym"
    | "scale_number"
    | "scale_word"
    | "text_observation"
    | "text"
    | "llm"
    | "partial"
    | "none";
  /** Optional explanation for the score. */
  reasoning?: string;
}

/**
 * Evaluate whether a user reply answers the pending question and score the confidence.
 *
 * Confidence scoring reflects match quality:
 * - Exact option/button/list match: 1.0
 * - Synonym or scale-word match: 0.9
 * - Scale number: 1.0
 * - Text question with a topic observation from perception: 0.8
 * - Text question without a topic observation: 0.6
 * - Multi-select partial match: proportional to matched options / total meaningful tokens
 * - No match: 0.0
 */
export function evaluateAnswerToPendingQuestion(
  message: InboundMessage,
  perception: PerceptionResult,
  pending: PendingQuestion,
  localeCode?: string
): AnswerConfidenceResult {
  const locale = localeCode ? getLocale(localeCode) : undefined;
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
    return { isAnswer: false, confidence: 0, matchMethod: "none", reasoning: `non-answer intent: ${perception.intent.primary}` };
  }

  if (pending.expectedResponseType === "text") {
    const topicObservation = perception.extractedObservations.find((o) => o.concept === pending.topic);
    if (topicObservation) {
      return { isAnswer: true, confidence: 0.8, matchMethod: "text_observation", reasoning: "perception extracted observation for pending topic" };
    }
    return { isAnswer: true, confidence: 0.6, matchMethod: "text", reasoning: "free-text reply to text question" };
  }

  const options = pending.options ?? [];
  const optionSet = new Set(options.map((o) => o.toLowerCase()));

  if (message.content.type === "button_reply" && message.content.buttonId) {
    const id = message.content.buttonId.toLowerCase();
    if (optionSet.has(id)) {
      return { isAnswer: true, confidence: 1, matchMethod: "exact_option", reasoning: "exact button option id" };
    }
  }

  if (message.content.type === "list_reply" && message.content.listId) {
    const id = message.content.listId.toLowerCase();
    if (optionSet.has(id)) {
      return { isAnswer: true, confidence: 1, matchMethod: "exact_option", reasoning: "exact list option id" };
    }
  }

  const text = (message.content.text ?? "").trim().toLowerCase();

  if (pending.expectedResponseType === "scale") {
    if (/^[1-5]$/.test(text)) {
      return { isAnswer: true, confidence: 1, matchMethod: "scale_number", reasoning: "numeric scale 1-5" };
    }
    if (locale && matchScaleWord(locale, text) !== undefined) {
      return { isAnswer: true, confidence: 0.9, matchMethod: "scale_word", reasoning: "scale word match" };
    }
  }

  if (pending.expectedResponseType === "single_choice") {
    if (optionSet.has(text)) {
      return { isAnswer: true, confidence: 1, matchMethod: "exact_option", reasoning: "exact option id text" };
    }
    if (locale) {
      const matched = options.some((optionId) => matchOptionSynonym(locale, optionId, text));
      if (matched) {
        return { isAnswer: true, confidence: 0.9, matchMethod: "synonym", reasoning: "option synonym match" };
      }
    }
  }

  if (pending.expectedResponseType === "multi_select") {
    const { matched, hasMeaningfulUnmatched } = extractMultiSelectAnswers(text, options, localeCode);
    if (matched.length > 0 && !hasMeaningfulUnmatched) {
      return { isAnswer: true, confidence: 1, matchMethod: "exact_option", reasoning: "all meaningful tokens matched options" };
    }
    if (matched.length > 0 && hasMeaningfulUnmatched) {
      // Partial answer: the reply is not a full answer, but we understood some of it.
      const confidence = Math.max(0.4, Math.min(0.9, matched.length / (matched.length + 1)));
      return { isAnswer: false, confidence, matchMethod: "partial", reasoning: `partial match: ${matched.length} option(s) understood` };
    }
  }

  // Accept free-text replies when perception extracted an observation for the pending topic.
  if (perception.extractedObservations.some((o) => o.concept === pending.topic)) {
    return { isAnswer: true, confidence: 0.8, matchMethod: "text_observation", reasoning: "perception extracted observation for pending topic" };
  }

  return { isAnswer: false, confidence: 0, matchMethod: "none", reasoning: "no rule-based match" };
}

export function isAnswerToPendingQuestion(
  message: InboundMessage,
  perception: PerceptionResult,
  pending: PendingQuestion,
  localeCode?: string
): boolean {
  return evaluateAnswerToPendingQuestion(message, perception, pending, localeCode).isAnswer;
}

export async function isAnswerRelevantWithLlm(
  message: InboundMessage,
  perception: PerceptionResult,
  pending: PendingQuestion,
  llmClient: LLMClient,
  onLlmCall?: LlmAuditCallback
): Promise<LlmRelevanceResult> {
  const systemPrompt = `You are the turn-management layer of CareMemory, a UK asthma follow-up assistant.
Your job is to decide whether a patient's free-text reply answers a specific check-in question.
Return ONLY valid JSON matching this schema:
{
  "isAnswer": boolean,
  "confidence": number between 0 and 1,
  "reasoning": string
}
Rules:
- Return isAnswer=true if the reply contains the information the question is asking for, even if phrased informally.
- Return isAnswer=false if the reply is off-topic, asks a question, asks for help, or does not address the question.
- Confidence should reflect your certainty: 1.0 = definitely answers, 0.0 = definitely not an answer.
- Do not diagnose or give treatment advice.`;

  const userPrompt = `Question purpose: ${pending.purpose}
Expected response type: ${pending.expectedResponseType}
Allowed options: ${JSON.stringify(pending.options ?? [])}
Patient reply: ${message.content.text ?? ""}
Perception extracted observations: ${JSON.stringify(perception.extractedObservations)}`;

  const fewShotExamples: LLMMessage[] = [
    {
      role: "user",
      content: `Question purpose: How often did you use your reliever inhaler in the last 48 hours?
Expected response type: single_choice
Allowed options: ["reliever_0","reliever_1","reliever_2","reliever_3_plus"]
Patient reply: "three or four times"
Perception extracted observations: []`,
    },
    {
      role: "assistant",
      content: JSON.stringify({
        isAnswer: true,
        confidence: 0.9,
        reasoning: "User gives a frequency that maps to the 3+ option.",
      }),
    },
    {
      role: "user",
      content: `Question purpose: Did asthma wake you up at night?
Expected response type: single_choice
Allowed options: ["night_none","night_mild","night_disturbed","night_woke_up"]
Patient reply: "What do you mean by wake up?"
Perception extracted observations: []`,
    },
    {
      role: "assistant",
      content: JSON.stringify({
        isAnswer: false,
        confidence: 0.1,
        reasoning: "User asks for clarification rather than answering.",
      }),
    },
    {
      role: "user",
      content: `Question purpose: Did asthma limit your daily activities?
Expected response type: single_choice
Allowed options: ["activity_no","activity_yes"]
Patient reply: "I went running but felt a bit tight in my chest"
Perception extracted observations: [{"concept":"activity_limitation","value":"yes"}]`,
    },
    {
      role: "assistant",
      content: JSON.stringify({
        isAnswer: true,
        confidence: 0.8,
        reasoning: "User describes an activity and a related symptom, which answers the activity limitation question.",
      }),
    },
  ];

  const messages: LLMMessage[] = [
    { role: "system", content: systemPrompt },
    ...fewShotExamples,
    { role: "user", content: userPrompt },
  ];

  try {
    const { content, usage } = await llmClient.complete(messages, { responseFormat: "json", temperature: 0.1 });
    if (onLlmCall) {
      await onLlmCall(llmClient.modelName, messages, content, usage);
    }
    const parsed = JSON.parse(content) as Partial<LlmRelevanceResult>;
    const isAnswer = !!parsed.isAnswer;
    const confidence = typeof parsed.confidence === "number" && !Number.isNaN(parsed.confidence)
      ? Math.max(0, Math.min(1, parsed.confidence))
      : (isAnswer ? 0.7 : 0.3);
    return { isAnswer, confidence, reasoning: parsed.reasoning };
  } catch {
    // Any LLM failure is treated as "not an answer" so we fallback to reprompt.
    return { isAnswer: false, confidence: 0 };
  }
}

export function detectTopicShift(
  perception: PerceptionResult,
  pending: PendingQuestion,
  answerEvaluation: AnswerConfidenceResult
): { isTopicShift: boolean; shiftedObservations: Observation[] } {
  if (answerEvaluation.isAnswer) {
    return { isTopicShift: false, shiftedObservations: [] };
  }

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
    return { isTopicShift: false, shiftedObservations: [] };
  }

  const nonInformativeConcepts = new Set([
    "uncertainty",
    "unknown",
    "dont_know",
    "not_sure",
    "no_information",
    "unsure",
    "no_answer",
  ]);

  const shifted = perception.extractedObservations.filter(
    (o) => o.concept !== pending.topic && !nonInformativeConcepts.has(o.concept)
  );
  if (shifted.length === 0) {
    return { isTopicShift: false, shiftedObservations: [] };
  }

  return { isTopicShift: true, shiftedObservations: shifted };
}

export async function buildTopicShiftAcknowledgementMessage(
  userId: string,
  pending: PendingQuestion,
  shiftedObservations: Observation[],
  options: RenderOptions
): Promise<OutboundMessage> {
  const concepts = shiftedObservations.map((o) => String(o.concept).replace(/_/g, " "));
  const uniqueConcepts = Array.from(new Set(concepts));
  const conceptText = uniqueConcepts.join(", ");

  const purpose = `Noted — thanks for mentioning ${conceptText}. I'll move on and come back to this if needed.`;

  const acknowledgementOutput: PlannerOutput = {
    reasoning: "User introduced a new topic instead of answering the pending question; acknowledging and moving on.",
    sessionObjective: pending.purpose,
    nextAction: {
      type: "inform",
      topic: "topic_shift_acknowledgement",
      purpose,
      budgetCost: 0,
    },
    safetyFlag: "none",
    updatePatientState: {},
  };

  return renderMessage(userId, acknowledgementOutput, options);
}

export async function recordTopicShift(
  prisma: PrismaClient,
  userId: string,
  cycleId: string,
  checkInId: string,
  pending: PendingQuestion,
  shiftedObservations: Observation[],
  eventId: string,
  now: Date,
  traceId?: string
): Promise<void> {
  await prisma.observation.create({
    data: {
      userId,
      cycleId,
      eventId,
      timestamp: now,
      category: "subjective" as ObservationCategory,
      concept: pending.topic,
      value: "no_answer" as Prisma.InputJsonValue,
      attributes: { reason: "topic_shift" } as Prisma.InputJsonValue,
      confidence: 1,
      extractedBy: "rule",
    },
  });

  await clearPendingQuestion(prisma, checkInId);

  await prisma.event.create({
    data: {
      userId,
      cycleId,
      checkInId,
      type: "user_action" as const,
      payload: {
        action: "topic_shift",
        topic: pending.topic,
        expectedResponseType: pending.expectedResponseType,
        shiftedConcepts: shiftedObservations.map((o) => o.concept),
      } as unknown as Prisma.InputJsonValue,
      timestamp: now,
      traceId,
    },
  });
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

const STOP_WORDS = new Set([
  "i",
  "i've",
  "i'd",
  "im",
  "i'm",
  "it",
  "its",
  "it's",
  "its",
  "the",
  "a",
  "an",
  "and",
  "or",
  "but",
  "so",
  "to",
  "of",
  "in",
  "on",
  "at",
  "for",
  "with",
  "about",
  "as",
  "by",
  "from",
  "had",
  "have",
  "has",
  "was",
  "were",
  "is",
  "are",
  "be",
  "been",
  "being",
  "my",
  "your",
  "mine",
  "yours",
  "this",
  "that",
  "these",
  "those",
  "me",
  "you",
  "he",
  "she",
  "we",
  "they",
  "them",
  "us",
  "some",
  "any",
  "all",
  "none",
  "no",
  "yes",
  "just",
  "only",
  "mostly",
  "mainly",
  "mostly",
  "probably",
  "maybe",
  "perhaps",
  "like",
  "kind",
  "sort",
  "bit",
  "little",
  "lot",
  "much",
  "many",
  "more",
  "most",
  "well",
  "too",
  "very",
  "quite",
  "really",
  "pretty",
  "rather",
  "almost",
  "also",
  "still",
  "even",
  "both",
  "either",
  "neither",
  "one",
  "two",
  "three",
  "first",
  "last",
  "next",
  "then",
  "there",
  "here",
  "now",
  "today",
  "yesterday",
  "tomorrow",
  "got",
  "get",
  "getting",
  "had",
  "been",
  "done",
  "made",
  "make",
  "making",
]);

export interface ExtractedAnswers {
  /** Option IDs that were matched in the user's reply. */
  matched: string[];
  /** Raw tokens that did not match any option or synonym. */
  unmatched: string[];
  /** True if there are unmatched tokens that are not just stop words/filler. */
  hasMeaningfulUnmatched: boolean;
}

/**
 * Extract matched option IDs from a free-text multi-select reply.
 *
 * Tokenizes on commas, "and", "or", and whitespace, then matches each token
 * against option IDs and locale synonyms. Stop words and filler are ignored.
 */
export function extractMultiSelectAnswers(
  text: string,
  options: string[],
  localeCode?: string
): ExtractedAnswers {
  const locale = localeCode ? getLocale(localeCode) : undefined;
  const lowerText = text.toLowerCase();

  // Try whole-phrase synonym matches first (e.g. "chest tightness" before splitting).
  const matchedSet = new Set<string>();
  for (const optionId of options) {
    if (locale && matchOptionSynonym(locale, optionId, lowerText)) {
      matchedSet.add(optionId);
    } else if (lowerText.includes(optionId.toLowerCase())) {
      matchedSet.add(optionId);
    }
  }

  // Tokenize for per-token matching.
  const tokens = text
    .split(/,|\band\b|\bor\b|\s+/i)
    .map((t) => t.trim())
    .filter(Boolean);

  const unmatched: string[] = [];

  for (const rawToken of tokens) {
    const token = rawToken.toLowerCase();
    if (STOP_WORDS.has(token) || token.length <= 1) continue;

    let tokenMatched = false;
    for (const optionId of options) {
      if (token === optionId.toLowerCase() || (locale && matchOptionSynonym(locale, optionId, token))) {
        matchedSet.add(optionId);
        tokenMatched = true;
        break;
      }
    }

    if (!tokenMatched) {
      unmatched.push(rawToken);
    }
  }

  const meaningfulUnmatched = unmatched.filter((t) => {
    const lower = t.toLowerCase();
    return !STOP_WORDS.has(lower) && lower.length > 2;
  });

  return {
    matched: Array.from(matchedSet),
    unmatched,
    hasMeaningfulUnmatched: meaningfulUnmatched.length > 0,
  };
}

export interface PartialAnswerResult {
  /** True if the reply contains at least one valid option but also has unmatched meaningful tokens. */
  isPartial: boolean;
  extracted: ExtractedAnswers;
}

/**
 * Decide whether a free-text reply to a multi-select pending question is partial.
 *
 * A reply is partial when it contains at least one valid option match but also
 * contains other meaningful words that we could not map to an option. In that
 * case we accept the matched options and ask the user to clarify the rest.
 */
export function detectPartialMultiSelectAnswer(
  message: InboundMessage,
  pending: PendingQuestion,
  localeCode?: string
): PartialAnswerResult {
  const extracted = extractMultiSelectAnswers(
    message.content.text ?? "",
    pending.options ?? [],
    localeCode
  );
  return {
    isPartial: extracted.matched.length > 0 && extracted.hasMeaningfulUnmatched,
    extracted,
  };
}

function formatOptionLabels(optionIds: string[], localeCode?: string): string[] {
  const locale = localeCode ? getLocale(localeCode) : undefined;
  return optionIds.map((id) => {
    if (locale) {
      const label = matchOptionSynonym(locale, id, id);
      if (label) return id;
    }
    return id;
  });
}

export async function buildPartialAnswerFollowUpMessage(
  userId: string,
  pending: PendingQuestion,
  matched: string[],
  unmatched: string[],
  options: RenderOptions
): Promise<OutboundMessage> {
  const locale = getLocale(options.locale);
  const matchedLabels = matched.map((id) => {
    const labels = locale.optionLabels[pending.topic];
    const idx = (pending.options ?? []).indexOf(id);
    if (labels && idx >= 0 && idx < labels.length) return labels[idx];
    return id;
  });

  const matchedText = matchedLabels.join(", ");
  const unmatchedText = unmatched.join(", ");

  let purpose = `Got it — I've recorded ${matchedText}.`;
  if (unmatchedText) {
    purpose += ` What did you mean by ${unmatchedText}?`;
  } else {
    purpose += " Is there anything else you'd like to add?";
  }

  const followUpOutput: PlannerOutput = {
    reasoning: "User gave a partial answer to a multi-select question; following up on unmatched tokens.",
    sessionObjective: pending.purpose,
    nextAction: {
      type: "ask",
      topic: pending.topic,
      purpose,
      expectedResponseType: "text",
      options: undefined,
      budgetCost: 0,
    },
    safetyFlag: "none",
    updatePatientState: {},
  };

  return renderMessage(userId, followUpOutput, options);
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


const CLARIFICATION_PATTERNS = [
  /what do you mean/i,
  /i.*don't understand/i,
  /can you explain/i,
  /could you clarify/i,
  /what does that mean/i,
  /repeat the question/i,
  /say that again/i,
  /i'm confused/i,
  /not sure what you're asking/i,
];

export function looksLikeClarificationRequest(text: string): boolean {
  return CLARIFICATION_PATTERNS.some((pattern) => pattern.test(text));
}

function formatOptionsForClarification(pending: PendingQuestion, localeCode?: string): string {
  const options = pending.options ?? [];
  if (options.length === 0) return "";

  const locale = localeCode ? getLocale(localeCode) : undefined;
  const labels = options.map((id) => {
    if (locale) {
      return matchOptionSynonym(locale, id, id) ?? id;
    }
    return id;
  });
  return labels.join(" / ");
}

export async function buildClarificationMessage(
  userId: string,
  pending: PendingQuestion,
  options: RenderOptions,
  clarificationCount = 0
): Promise<OutboundMessage> {
  const locale = getLocale(options.locale);
  const optionsText = formatOptionsForClarification(pending, options.locale);
  const purpose = pending.purpose.replace(/\?$/, "").trim();

  let text: string;
  if (clarificationCount === 0) {
    text = `No problem — I'm asking: ${purpose}.`;
    if (optionsText) {
      text += ` You can reply with: ${optionsText}.`;
    } else {
      text += " Just reply in your own words.";
    }
  } else if (clarificationCount === 1) {
    text = `Let me rephrase: ${purpose}.`;
    const example = buildExampleAnswer(pending, locale);
    if (example) {
      text += ` For example: ${example}.`;
    }
    text += " Reply SKIP if you'd rather move on.";
  } else {
    text = `I'm having trouble understanding. Reply SKIP to move on, or tell me in your own words and I'll record it.`;
  }

  const clarificationOutput: PlannerOutput = {
    reasoning: "User asked for clarification on the pending question.",
    sessionObjective: pending.purpose,
    nextAction: {
      type: "ask",
      topic: pending.topic,
      purpose: text,
      expectedResponseType: pending.expectedResponseType,
      options: pending.options,
      budgetCost: 0,
    },
    safetyFlag: "none",
    updatePatientState: {},
  };

  return renderMessage(userId, clarificationOutput, options);
}

function buildExampleAnswer(pending: PendingQuestion, locale: DialogueLocale): string | undefined {
  if (pending.expectedResponseType === "scale") {
    return '"3" or "moderate"';
  }
  if (pending.expectedResponseType === "single_choice" && pending.options && pending.options.length > 0) {
    const firstOption = pending.options[0];
    const labels = locale.optionLabels[pending.topic];
    const idx = pending.options.indexOf(firstOption);
    const label = labels?.[idx] ?? firstOption;
    return `"${label}"`;
  }
  if (pending.expectedResponseType === "multi_select" && pending.options && pending.options.length > 0) {
    const firstTwo = pending.options.slice(0, 2);
    const labels = locale.optionLabels[pending.topic];
    const exampleLabels = firstTwo.map((id, idx) => labels?.[idx] ?? id);
    return `"${exampleLabels.join(" and ")}"`;
  }
  return undefined;
}

const SKIP_PATTERNS = [
  /^skip$/i,
  /skip this question/i,
  /skip it/i,
  /next question/i,
  /pass/i,
  /i don't want to answer/i,
  /i'd rather not answer/i,
  /i'd rather not say/i,
  /prefer not to answer/i,
  /don't ask me that/i,
];

export function looksLikeSkipRequest(text: string): boolean {
  return SKIP_PATTERNS.some((pattern) => pattern.test(text.trim()));
}

export async function recordSkippedQuestion(
  prisma: PrismaClient,
  userId: string,
  cycleId: string,
  checkInId: string,
  pending: PendingQuestion,
  eventId: string,
  now: Date,
  traceId?: string
): Promise<void> {
  await prisma.observation.create({
    data: {
      userId,
      cycleId,
      eventId,
      timestamp: now,
      category: "subjective" as ObservationCategory,
      concept: pending.topic,
      value: "no_answer" as Prisma.InputJsonValue,
      attributes: { reason: "user_skipped" } as Prisma.InputJsonValue,
      confidence: 1,
      extractedBy: "rule",
    },
  });

  await clearPendingQuestion(prisma, checkInId);

  await prisma.event.create({
    data: {
      userId,
      cycleId,
      checkInId,
      type: "user_action" as const,
      payload: {
        action: "skip_question",
        topic: pending.topic,
        expectedResponseType: pending.expectedResponseType,
      } as unknown as Prisma.InputJsonValue,
      timestamp: now,
      traceId,
    },
  });
}

const GO_BACK_PATTERNS = [
  /^go back$/i,
  /previous question/i,
  /last question/i,
  /^back$/i,
  /go to the previous/i,
  /i want to change my answer/i,
  /change my answer/i,
];

export function looksLikeGoBackRequest(text: string): boolean {
  return GO_BACK_PATTERNS.some((pattern) => pattern.test(text.trim()));
}

export interface GoBackResult {
  previousQuestion?: PendingQuestion;
  hasHistory: boolean;
}

export async function goBackToPreviousQuestion(
  prisma: PrismaClient,
  checkInId: string
): Promise<GoBackResult> {
  const current = await prisma.checkIn.findUnique({
    where: { id: checkInId },
    select: { questionHistory: true },
  });
  const history = (current?.questionHistory as PendingQuestion[] | undefined) ?? [];
  if (history.length === 0) {
    return { hasHistory: false };
  }

  const previousQuestion = history[history.length - 1];
  const newHistory = history.slice(0, -1);

  await prisma.checkIn.update({
    where: { id: checkInId },
    data: {
      pendingQuestion: previousQuestion as unknown as Prisma.InputJsonValue,
      repromptCount: 0,
      questionHistory: newHistory as unknown as Prisma.InputJsonValue,
    },
  });

  return { previousQuestion, hasHistory: true };
}

export async function buildPreviousQuestionMessage(
  userId: string,
  pending: PendingQuestion,
  options: RenderOptions
): Promise<OutboundMessage> {
  const previousOutput: PlannerOutput = {
    reasoning: "User asked to go back to the previous question.",
    sessionObjective: pending.purpose,
    nextAction: {
      type: "ask",
      topic: pending.topic,
      purpose: `Going back: ${pending.purpose}`,
      expectedResponseType: pending.expectedResponseType,
      options: pending.options,
      budgetCost: 0,
    },
    safetyFlag: "none",
    updatePatientState: {},
  };

  return renderMessage(userId, previousOutput, options);
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
  const current = await prisma.checkIn.findUnique({
    where: { id: checkInId },
    select: { pendingQuestion: true, questionHistory: true },
  });
  const history = (current?.questionHistory as PendingQuestion[] | undefined) ?? [];
  const currentPending = current?.pendingQuestion as PendingQuestion | undefined;

  await prisma.checkIn.update({
    where: { id: checkInId },
    data: {
      pendingQuestion: pending as unknown as Prisma.InputJsonValue,
      repromptCount: 0,
      questionHistory: [
        ...history,
        ...(currentPending ? [currentPending] : []),
      ] as unknown as Prisma.InputJsonValue,
    },
  });
}
