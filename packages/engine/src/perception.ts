import type { InboundMessage } from "@carememory/im-core";
import { loadDiseaseCorpus, searchCorpus, type CorpusSection } from "@carememory/rag";
import type { PerceptionResult, PerceptionContext, Observation, Anomaly, SafetyFlag } from "./types.js";
import type { LLMClient, LLMMessage } from "./llm.js";
import crypto from "node:crypto";

// Non-disease-specific system commands (equality match)
const SYSTEM_COMMANDS = ["STOP", "HELP", "DELETE MY DATA", "EXPORT MY DATA", "AGREE", "SKIP", "OK"];

export interface LlmAuditCallback {
  (model: string, input: unknown, output: string, tokenUsage?: { promptTokens?: number; completionTokens?: number; totalTokens?: number }): Promise<void> | void;
}

export async function perceive(
  message: InboundMessage,
  llmClient?: LLMClient,
  onLlmCall?: LlmAuditCallback,
  allowLlm = true,
  disease = "asthma",
  context?: PerceptionContext
): Promise<PerceptionResult> {
  const text = (message.content.text ?? "").trim();
  const result: PerceptionResult = {
    messageId: message.messageId,
    timestamp: message.timestamp ?? new Date(),
    traceId: crypto.randomUUID(),
    intent: { primary: "answer", confidence: 1.0 },
    extractedObservations: [],
    anomalies: [],
    safetyFlags: [],
    rawText: text,
  };

  // User-initiated correction intent (e.g. "I was wrong, actually...")
  if (looksLikeCorrection(text)) {
    result.intent = { primary: "correction", confidence: 0.9 };
  }

  // System commands are handled deterministically
  const upperText = text.toUpperCase();
  const diseaseUpper = disease.toUpperCase();
  if (upperText.startsWith("START ") && upperText.includes(diseaseUpper)) {
    result.intent = { primary: "initiate", confidence: 1.0 };
    result.extractedObservations.push(makeObservation("system_intent", `start_${disease}`, { command: text, disease }));
    return result;
  }
  if (upperText === "AGREE") {
    result.intent = { primary: "consent", confidence: 1.0 };
    result.extractedObservations.push(makeObservation("system_intent", "consent_given", { version: "v1" }));
    return result;
  }
  if (upperText === "SKIP" || upperText === "OK") {
    result.intent = { primary: upperText === "SKIP" ? "skip" : "confirm", confidence: 1.0 };
    result.extractedObservations.push(makeObservation("system_intent", upperText.toLowerCase(), {}));
    return result;
  }
  if (upperText === "STOP" || upperText === "DELETE MY DATA" || upperText === "EXPORT MY DATA") {
    const intentMap: Record<string, string> = {
      STOP: "stop",
      "DELETE MY DATA": "delete_data",
      "EXPORT MY DATA": "export_data",
    };
    result.intent = { primary: intentMap[upperText], confidence: 1.0 };
    result.extractedObservations.push(makeObservation("system_intent", upperText.toLowerCase().replace(/ /g, "_"), {}));
    return result;
  }
  if (upperText === "HELP") {
    result.intent = { primary: "help", confidence: 1.0 };
    result.extractedObservations.push(makeObservation("system_intent", "help", {}));
    return result;
  }
  if (upperText === "CONTINUE") {
    result.intent = { primary: "continue_cycle", confidence: 1.0 };
    result.extractedObservations.push(makeObservation("system_intent", "continue_cycle", {}));
    return result;
  }
  if (upperText === "YES" || upperText === "Y" || upperText === "ADD TO LAST RECORD" || upperText === "RECENT") {
    result.intent = { primary: "confirm_recent_context", confidence: 1.0 };
    result.extractedObservations.push(makeObservation("system_intent", "confirm_recent_context", { command: text }));
    return result;
  }

  // Button reply observations
  if (message.content.type === "button_reply" && message.content.buttonId) {
    const obs = mapButtonToObservation(message.content.buttonId, text);
    if (obs) {
      result.extractedObservations.push(obs);
    }
    return result;
  }

  // When no active check-in exists, treat free-text as user-initiated consultation.
  // This allows the engine to distinguish "answering a check-in question" from
  // "user reaching out on their own" (D8: intent stack, no budget consumption).
  if (context?.checkInActive === false) {
    result.intent = { primary: "question", confidence: 0.8 };
  }

  // Fast-path safety heuristics always run (base patterns + RAG safety-rules escalation triggers)
  if (/severe|can'?t breathe|cannot breathe|difficulty breathing|shortness of breath|chest tightness|worst|999|emergency|ambulance|blue lips|peak flow|no relief/i.test(text)) {
    result.safetyFlags.push({
      type: "severe_symptom_language",
      riskLevel: "high",
      description: "User message contains severe symptom or emergency language.",
    });
  }

  // Wheezing during or after activity can signal loss of control; treat as medium anomaly
  // so the planner enters exception mode without triggering the high-risk fast-path.
  if (/\bwheez/i.test(text)) {
    result.anomalies.push({
      type: "possible_worsening_symptom",
      description: "User reports wheezing.",
      severity: "medium",
    });
  }

  if (/rash|swelling|allergic|side effect|made me feel worse|vomit|dizziness|palpitations/i.test(text)) {
    result.anomalies.push({
      type: "possible_adverse_event",
      description: "User reports possible adverse reaction.",
      severity: "medium",
    });
  }

  // Compound signal conflict: multiple worsening indicators in one message.
  const compoundCount = [
    /worse|worsening|increasing|more frequent/i,
    /woke|waking|night|sleep/i,
    /reliever|inhaler|puff/i,
    /activity|exercise|walking|stairs/i,
  ].filter((p) => p.test(text)).length;
  if (compoundCount >= 3) {
    result.anomalies.push({
      type: "compound_signal_conflict",
      description: "Multiple worsening signals detected in a single message.",
      severity: "medium",
    });
  }

  // Severity escalation: sudden or rapid worsening language.
  if (/sudden|rapidly|much worse|significantly worse|worst ever/i.test(text)) {
    result.anomalies.push({
      type: "severity_escalation",
      description: "Patient reports rapid or significant symptom escalation.",
      severity: "high",
    });
  }

  // Management rule violation: reliever overuse without controller mention.
  if (/(\b[3-9]\b|10|\d{2,})\s*(times|puffs|doses)/i.test(text) && /\breliever\b/i.test(text) && !/\bcontroller\b/i.test(text)) {
    result.anomalies.push({
      type: "management_rule_violation",
      description: "High reliever use reported without controller adherence. May indicate inadequate preventer control.",
      severity: "medium",
    });
  }

  // Load RAG context: retrieve relevant disease knowledge and safety rules
  const corpus = loadDiseaseCorpus(disease);
  const ragSections = text ? searchCorpus(corpus, text, { topK: 3 }) : [];

  // Free-text: use LLM with RAG context when available, otherwise rule-based extraction
  if (llmClient && allowLlm) {
    try {
      const llmResult = await perceiveWithLlm(llmClient, text, ragSections, disease, context, onLlmCall);
      result.intent = llmResult.intent;
      result.extractedObservations = llmResult.extractedObservations;
      result.anomalies.push(...llmResult.anomalies);
      result.safetyFlags.push(...llmResult.safetyFlags);

      // Deterministic guard: wheezing on its own is concerning but not an emergency.
      // Downgrade any LLM high safety flag for wheezing to medium so the engine enters
      // exception mode instead of the emergency fast-path.
      if (/\bwheez/i.test(text)) {
        result.safetyFlags = result.safetyFlags.map((f) =>
          f.riskLevel === "high" ? { ...f, riskLevel: "medium" as const } : f
        );
        if (!result.anomalies.some((a) => /wheez/i.test(a.description))) {
          result.anomalies.push({
            type: "possible_worsening_symptom",
            description: "User reports wheezing.",
            severity: "medium",
          });
        }
      }

      return result;
    } catch {
      // Fall through to rule-based extraction
    }
  }

  // Rule-based extraction fallback: use RAG corpus keywords for basic concept mapping.
  const ruleObs = extractWithRules(text, ragSections);
  if (ruleObs.length > 0) {
    result.extractedObservations.push(...ruleObs);
  } else {
    result.extractedObservations.push(makeObservation("subjective", "free_text_response", text));
  }
  return result;
}

async function perceiveWithLlm(
  llmClient: LLMClient,
  text: string,
  ragSections: CorpusSection[],
  disease: string,
  context: PerceptionContext | undefined,
  onLlmCall?: LlmAuditCallback
): Promise<Pick<PerceptionResult, "intent" | "extractedObservations" | "anomalies" | "safetyFlags" | "rawText">> {
  const ragContextBlock = ragSections.length > 0
    ? `\nRelevant disease knowledge (use as reference for concept names and anomaly types):\n${ragSections.map((s) => `## ${s.title}${s.source ? ` (${s.source})` : ""}\n${s.content.trim()}`).join("\n\n")}\n`
    : "";

  const sessionContextBlock = context?.checkInActive && context.sessionObjective
    ? `\nThe patient is currently responding to the check-in question: "${context.sessionObjective}"\n`
    : context?.checkInActive
      ? `\nThe patient is currently in an active check-in session.\n`
      : "";

  const systemPrompt = `You are the perception layer of CareMemory. Current disease context: ${disease}.${sessionContextBlock}
Analyse the patient's free-text message and return ONLY valid JSON matching this schema:
{
  "intent": { "primary": "answer" | "question" | "adverse_event" | "help" | "stop" | "delete_data" | "export_data", "confidence": number },
  "extractedObservations": [
    { "category": "symptom" | "medication" | "trigger" | "function" | "adverse_event" | "subjective" | "question", "concept": string, "value": any, "attributes": { "severity"?: string, "frequency"?: string, "duration"?: string } }
  ],
  "anomalies": [
    { "type": "management_rule_violation" | "compound_signal_conflict" | "possible_adverse_event" | "severity_escalation" | "pattern_contradiction", "description": string, "severity": "low" | "medium" | "high" }
  ],
  "safetyFlags": [
    { "type": string, "riskLevel": "none" | "low" | "medium" | "high", "description": string }
  ]
}${ragContextBlock}
Guidelines:
- Use "adverse_event" as primary intent when the patient reports a suspected drug reaction or side effect (not just as an anomaly).
- Use "question" when the patient is asking their own question, not answering a check-in prompt.
- For each extracted observation, include an "attributes" object with severity, frequency, or duration when the message implies them.
- Detect anomalies by type: management_rule_violation (response contradicts care guidelines), compound_signal_conflict (multiple worsening signals together), severity_escalation (sudden worsening), pattern_contradiction (contradicts known patterns).
- For safetyFlags: use riskLevel "high" ONLY for emergency language (e.g., can't breathe, 999, blue lips, no relief). Use "medium" for concerning but non-emergency symptoms such as wheezing or chest tightness that has eased.
Do not diagnose or give treatment advice. Use concept names like "nighttime_symptoms", "reliever_use", "activity_limitation", "trigger_exposure", "controller_adherence" when applicable.`;

  const messages: LLMMessage[] = [
    { role: "system", content: systemPrompt },
    { role: "user", content: text },
  ];
  const { content, usage } = await llmClient.complete(messages, { responseFormat: "json", temperature: 0.2 });

  if (onLlmCall) {
    await onLlmCall(llmClient.modelName, messages, content, usage);
  }

  const parsed = JSON.parse(content) as Partial<PerceptionResult>;

  // Return only the LLM-populated fields; the caller (perceive) owns the full result
  // and merges these into the pre-populated messageId/timestamp/traceId.
  return {
    intent: parsed.intent ?? { primary: "answer", confidence: 0.5 },
    extractedObservations: (parsed.extractedObservations ?? []).map((o) => ({
      ...o,
      confidence: o.confidence ?? 0.8,
      extractedBy: "llm" as const,
    })),
    anomalies: (parsed.anomalies ?? []).map((a) => ({ ...a, severity: a.severity ?? "medium" })),
    safetyFlags: (parsed.safetyFlags ?? []).map((f) => ({ ...f, riskLevel: f.riskLevel ?? "low" })),
    rawText: text,
  };
}

function looksLikeCorrection(text: string): boolean {
  const phrases = [
    /\bi was wrong\b/i,
    /\bi meant\b/i,
    /\bactually\b/i,
    /\bcorrection\b/i,
    /\bi made a mistake\b/i,
    /\bnot \d+, (it was|it's|its) \d+/i,
  ];
  return phrases.some((p) => p.test(text));
}

function makeObservation(category: Observation["category"], concept: string, value: unknown): Observation {
  return {
    category,
    concept,
    value,
    confidence: 1.0,
    extractedBy: "rule",
  };
}

function mapButtonToObservation(buttonId: string, _text: string): Observation | null {
  return DEFAULT_BUTTON_MAP[buttonId] ?? null;
}

/** Default button→observation mapping for asthma. Override via `perceive()` options
 *  when adding support for additional diseases. */
export const DEFAULT_BUTTON_MAP: Record<string, Observation> = {
    night_none: { category: "symptom", concept: "nighttime_symptoms", value: "none", confidence: 1, extractedBy: "rule" },
    night_mild: { category: "symptom", concept: "nighttime_symptoms", value: "mild", confidence: 1, extractedBy: "rule" },
    night_disturbed: { category: "symptom", concept: "nighttime_symptoms", value: "disturbed_sleep", confidence: 1, extractedBy: "rule" },
    night_woke_up: { category: "symptom", concept: "nighttime_symptoms", value: "woke_me_up", confidence: 1, extractedBy: "rule" },
    reliever_0: { category: "medication", concept: "reliever_use", value: 0, confidence: 1, extractedBy: "rule" },
    reliever_1: { category: "medication", concept: "reliever_use", value: 1, confidence: 1, extractedBy: "rule" },
    reliever_2: { category: "medication", concept: "reliever_use", value: 2, confidence: 1, extractedBy: "rule" },
    reliever_3_plus: { category: "medication", concept: "reliever_use", value: "3_or_more", confidence: 1, extractedBy: "rule" },
    activity_no: { category: "function", concept: "activity_limitation", value: "no", confidence: 1, extractedBy: "rule" },
    activity_yes: { category: "function", concept: "activity_limitation", value: "yes", confidence: 1, extractedBy: "rule" },
    adherence_yes: { category: "medication", concept: "controller_adherence", value: "yes", confidence: 1, extractedBy: "rule" },
    adherence_no: { category: "medication", concept: "controller_adherence", value: "no", confidence: 1, extractedBy: "rule" },
    adherence_skip: { category: "medication", concept: "controller_adherence", value: "skip", confidence: 1, extractedBy: "rule" },
    trigger_pollen: { category: "trigger", concept: "exposure", value: "pollen", confidence: 1, extractedBy: "rule" },
    trigger_dust: { category: "trigger", concept: "exposure", value: "dust", confidence: 1, extractedBy: "rule" },
    trigger_cold: { category: "trigger", concept: "exposure", value: "cold_air", confidence: 1, extractedBy: "rule" },
    trigger_exercise: { category: "trigger", concept: "exposure", value: "exercise", confidence: 1, extractedBy: "rule" },
  };

/** Rule-based extraction fallback: use RAG corpus keywords for basic concept mapping
 *  when LLM is unavailable. Extracts symptom/medication keywords and numeric values. */
function extractWithRules(text: string, ragSections: CorpusSection[]): Observation[] {
  const observations: Observation[] = [];
  const lower = text.toLowerCase();

  // Extract keywords from RAG corpus content
  const medicalTerms = extractMedicalKeywords(ragSections);

  // Map known symptom keywords
  const symptomKeywords: Array<{ pattern: RegExp; concept: string; category: Observation["category"] }> = [
    { pattern: /\bcough\b/i, concept: "cough", category: "symptom" },
    { pattern: /\bwheez/i, concept: "wheeze", category: "symptom" },
    { pattern: /\b(chest tightness|tight chest)\b/i, concept: "chest_tightness", category: "symptom" },
    { pattern: /\b(shortness of breath|breathless|out of breath)\b/i, concept: "breathlessness", category: "symptom" },
    { pattern: /\bnight(time)?\s*(woke|waking|wake|cough|symptom)\b/i, concept: "nighttime_symptoms", category: "symptom" },
    { pattern: /\b(reliever|inhaler|puff)\b/i, concept: "reliever_use", category: "medication" },
    { pattern: /\b(controller|preventer)\b/i, concept: "controller_adherence", category: "medication" },
  ];

  for (const kw of symptomKeywords) {
    if (kw.pattern.test(lower)) {
      // Try to extract a numeric value from the text near the keyword
      const numMatch = text.match(/(\d+)/);
      observations.push(makeObservation(kw.category, kw.concept, numMatch ? parseInt(numMatch[1], 10) : "reported"));
      break; // One primary concept per fallback message
    }
  }

  // Also check RAG medical-overview terms against the text
  for (const term of medicalTerms) {
    if (lower.includes(term.toLowerCase()) && observations.length === 0) {
      observations.push(makeObservation("symptom", term.toLowerCase().replace(/\s+/g, "_"), "reported"));
      break;
    }
  }

  return observations;
}

/** Extract symptom-related keywords from RAG medical-overview sections. */
function extractMedicalKeywords(sections: CorpusSection[]): string[] {
  const keywords: string[] = [];
  for (const s of sections) {
    if (s.source === "medical-overview.md" || s.source === "safety-rules.md") {
      // Extract quoted terms and key phrases from content
      const matches = s.content.match(/\b(wheeze|cough|chest tightness|shortness of breath|breathless|blue lips|peak flow|waking|woken|reliever|controller|inhaler|exacerbation|sputum|phlegm)\b/gi);
      if (matches) {
        for (const m of matches) {
          if (!keywords.includes(m.toLowerCase())) {
            keywords.push(m.toLowerCase());
          }
        }
      }
    }
  }
  return keywords;
}
