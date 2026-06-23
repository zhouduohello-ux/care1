import type { InboundMessage, OutboundMessage } from "@carememory/im-core";
import type { PrismaClient, ObservationCategory } from "@carememory/db";

import type { LLMClient } from "./llm.js";
import type { QuotaStore } from "./llm-quota.js";

export type LlmModelType = "perception" | "planner" | "dialogue" | "safety";

export interface EngineContext {
  prisma: PrismaClient;
  now: Date;
  quotaStore?: QuotaStore;
  createExportToken?: (userId: string) => Promise<string>;
  webBaseUrl?: string;
  llmClient?: LLMClient;
  llmClientFor?: (model: LlmModelType) => LLMClient | undefined;
}

export interface Observation {
  category: ObservationCategory;
  concept: string;
  value: unknown;
  attributes?: Record<string, unknown>;
  confidence?: number;
  extractedBy?: "rule" | "llm";
}

export interface PerceptionResult {
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
  };
  conversationContext: {
    currentIntent: string;
    intentStack: string[];
    questionsAskedThisSession: number;
    budgetRemaining: number;
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

export interface EngineTrace {
  perception: PerceptionResult;
  planner: PlannerOutput;
  safety: SafetyResult;
}

export interface Engine {
  handleInbound(context: EngineContext, message: InboundMessage): Promise<OutboundMessage[]>;
  handleCheckInTrigger(context: EngineContext, cycleId: string): Promise<OutboundMessage[]>;
}
