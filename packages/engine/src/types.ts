import type { InboundMessage, OutboundMessage } from "@carememory/im-core";
import type { PrismaClient, ObservationCategory } from "@carememory/db";

import type { LLMClient, LLMConfig } from "./llm.js";
import type { QuotaStore } from "./llm-quota.js";
import type { TemplateResolver } from "./dialogue.js";
import type { MedicationBaseline } from "./question-bank.js";

export type LlmModelType = "perception" | "planner" | "dialogue" | "safety";

export interface EngineContext {
  prisma: PrismaClient;
  now: Date;
  quotaStore?: QuotaStore;
  createExportToken?: (userId: string) => Promise<string>;
  webBaseUrl?: string;
  /**
   * Optional platform-specific template resolver. When provided, L5 can render
   * `content.type === "template"` messages for platforms that require pre-approved
   * templates outside the 24h session window.
   */
  templateResolver?: TemplateResolver;
  /**
   * Unified LLM configuration. Set once at startup via `loadLLMConfig()`.
   * The engine internally resolves the right `LLMClient` per layer with caching.
   * When absent or `{ enabled: false }`, all layers fall back to rule-based logic.
   */
  llmConfig?: LLMConfig;
}

/** Minimal session context passed into L1 perception to aid intent disambiguation. */
export interface PerceptionContext {
  /** Whether there is an active check-in (SENT / SCHEDULED) expecting a reply. */
  checkInActive: boolean;
  /** The session objective of the current check-in, if any. */
  sessionObjective?: string;
}

export interface Observation {
  id?: string;
  category: ObservationCategory;
  concept: string;
  value: unknown;
  attributes?: Record<string, unknown>;
  confidence?: number;
  extractedBy?: "rule" | "llm";
}

export interface PerceptionResult {
  messageId: string;
  timestamp: Date;
  traceId: string;
  intent: {
    primary: string;
    confidence: number;
  };
  extractedObservations: Observation[];
  anomalies: Anomaly[];
  safetyFlags: SafetyFlag[];
  rawText: string;
}

export interface Anomaly {
  type: string;
  description: string;
  severity: "low" | "medium" | "high";
}

export interface SafetyFlag {
  type: string;
  riskLevel: "none" | "low" | "medium" | "high";
  description: string;
}

export interface PlannerInput {
  patientContext: {
    disease: string;
    cycleId: string;
    cycleDay: number;
    narrativeSummary: string;
    recentObservations: Observation[];
    openIssues: string[];
    upcomingVisitDays?: number;
    medications?: MedicationBaseline;
  };
  conversationContext: {
    currentIntent: string;
    intentStack: string[];
    questionsAskedThisSession: number;
    budgetRemaining: number;
    turnsRemaining?: number;
    lastUserMessage?: string;
    inExceptionMode: boolean;
    exceptionQuestionsAsked?: number;
    conversationStyle?: string;
  };
  temporalContext: {
    localTime: string;
    season?: string;
    dayOfWeek: string;
  };
  retrievedKnowledge?: {
    careStrategy?: string[];
    medicalKb?: string[];
    patterns?: string[];
  };
}

export interface PlannerOutput {
  reasoning: string;
  sessionObjective: string;
  nextAction: {
    type: "ask" | "inform" | "remind" | "safety_response" | "generate_brief" | "end_session";
    topic: string;
    purpose: string;
    expectedResponseType?: "single_choice" | "scale" | "multi_select" | "text";
    options?: string[];
    budgetCost: number;
  };
  alternativeActions?: PlannerOutput["nextAction"][];
  safetyFlag: "none" | "low" | "medium" | "high";
  updatePatientState: {
    newObservations?: Observation[];
    updateNarrative?: boolean;
    addOpenIssue?: string;
    resolveOpenIssue?: string;
  };
}

export interface SafetyResult {
  approved: boolean;
  rewrittenMessage?: string;
  requiredAddendums: string[];
  riskLevel: "none" | "low" | "medium" | "high";
  blockReason?: string;
}

export interface DialogueTrace {
  input: {
    actionType: PlannerOutput["nextAction"]["type"];
    topic: string;
    expectedResponseType?: string;
    optionCount?: number;
  };
  output: {
    contentType: OutboundMessage["content"]["type"];
    priority: "normal" | "urgent";
    requiresSession: boolean;
    templated: boolean;
    polished: boolean;
  };
  context: {
    style: string;
    locale: string;
    cycleType?: string;
    cycleDay?: number;
  };
}

export interface EngineTrace {
  perception: PerceptionResult;
  planner: PlannerOutput;
  dialogue?: DialogueTrace;
  safety: SafetyResult;
}

export interface Engine {
  handleInbound(context: EngineContext, message: InboundMessage): Promise<OutboundMessage[]>;
  handleCheckInTrigger(context: EngineContext, cycleId: string): Promise<OutboundMessage[]>;
}
