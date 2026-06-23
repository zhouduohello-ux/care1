import type { InboundMessage } from "@carememory/im-core";
import type { PerceptionResult, Observation, Anomaly, SafetyFlag } from "./types.js";
import type { LLMClient, LLMMessage } from "./llm.js";

const SYSTEM_COMMANDS = ["START ASTHMA", "STOP", "HELP", "DELETE MY DATA", "EXPORT MY DATA", "AGREE", "SKIP", "OK"];

export interface LlmAuditCallback {
  (model: string, input: unknown, output: string, tokenUsage?: { prompt?: number; completion?: number; total?: number }): Promise<void> | void;
}

export async function perceive(
  message: InboundMessage,
  llmClient?: LLMClient,
  onLlmCall?: LlmAuditCallback,
  allowLlm = true
): Promise<PerceptionResult> {
  const text = (message.content.text ?? "").trim();
  const result: PerceptionResult = {
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
  if (upperText.startsWith("START ASTHMA")) {
    result.intent = { primary: "initiate", confidence: 1.0 };
    result.extractedObservations.push(makeObservation("system_intent", "start_asthma", { command: text }));
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

  // Fast-path safety heuristics always run
  if (/severe|can't breathe|cannot breathe|difficulty breathing|worst|999|emergency|ambulance/i.test(text)) {
    result.safetyFlags.push({
      type: "severe_symptom_language",
      riskLevel: "high",
      description: "User message contains severe symptom or emergency language.",
    });
  }

  if (/rash|swelling|allergic|side effect|made me feel worse/i.test(text)) {
    result.anomalies.push({
      type: "possible_adverse_event",
      description: "User reports possible adverse reaction.",
      severity: "medium",
    });
  }

  // Free-text: use LLM when available and quota allows, otherwise rule fallback
  if (llmClient && allowLlm) {
    try {
      const llmResult = await perceiveWithLlm(llmClient, text, onLlmCall);
      result.intent = llmResult.intent;
      result.extractedObservations = llmResult.extractedObservations;
      result.anomalies.push(...llmResult.anomalies);
      result.safetyFlags.push(...llmResult.safetyFlags);
      return result;
    } catch {
      // Fall through to rule-based extraction
    }
  }

  result.extractedObservations.push(makeObservation("subjective", "free_text_response", text));
  return result;
}

async function perceiveWithLlm(
  llmClient: LLMClient,
  text: string,
  onLlmCall?: LlmAuditCallback
): Promise<PerceptionResult> {
  const systemPrompt = `You are the perception layer of CareMemory, a UK asthma follow-up assistant.
Analyse the patient's free-text message and return ONLY valid JSON matching this schema:
{
  "intent": { "primary": "answer" | "adverse_event" | "help" | "stop" | "delete_data" | "export_data", "confidence": number },
  "extractedObservations": [
    { "category": "symptom" | "medication" | "trigger" | "function" | "adverse_event" | "subjective", "concept": string, "value": any }
  ],
  "anomalies": [
    { "type": string, "description": string, "severity": "low" | "medium" | "high" }
  ],
  "safetyFlags": [
    { "type": string, "riskLevel": "none" | "low" | "medium" | "high", "description": string }
  ]
}
Do not diagnose or give treatment advice. Use concept names like "nighttime_symptoms", "reliever_use", "activity_limitation", "trigger_exposure", "controller_adherence" when applicable.`;

  const messages: LLMMessage[] = [
    { role: "system", content: systemPrompt },
    { role: "user", content: text },
  ];
  const content = await llmClient.complete(messages, { responseFormat: "json", temperature: 0.2 });

  if (onLlmCall) {
    await onLlmCall("perception", messages, content);
  }

  const parsed = JSON.parse(content) as Partial<PerceptionResult>;

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

function mapButtonToObservation(buttonId: string, text: string): Observation | null {
  const map: Record<string, Observation> = {
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
    trigger_pollen: { category: "trigger", concept: "exposure", value: "pollen", confidence: 1, extractedBy: "rule" },
    trigger_dust: { category: "trigger", concept: "exposure", value: "dust", confidence: 1, extractedBy: "rule" },
    trigger_cold: { category: "trigger", concept: "exposure", value: "cold_air", confidence: 1, extractedBy: "rule" },
    trigger_exercise: { category: "trigger", concept: "exposure", value: "exercise", confidence: 1, extractedBy: "rule" },
  };
  return map[buttonId] ?? null;
}
