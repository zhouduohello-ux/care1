import type { OutboundMessage } from "@carememory/im-core";
import type { SafetyResult } from "./types.js";
import { loadSafetyRules } from "@carememory/rag";

const PROHIBITED_PATTERNS = [
  /you (have|are having) (an asthma attack|a severe attack|an attack)/i,
  /you should (increase|decrease|stop|start|change) (your medication|your inhaler|the dose)/i,
  /take \d+ puffs? (of|from) your/i,
  /you need (steroids|antibiotics|a nebulizer)/i,
  /your asthma is (severe|uncontrolled|life-threatening)/i,
];

const FALLBACK_EMERGENCY_ADDENDUM =
  "If you're having severe breathing problems, call 999 or follow your asthma action plan.";
const FALLBACK_MEDICAL_DISCLAIMER =
  "This is based on patient-reported information only and is not medical advice.";

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function phraseToPattern(phrase: string): RegExp {
  const trimmed = phrase.replace(/[.!?]+$/, "").trim();
  const escaped = escapeRegExp(trimmed);
  return new RegExp(escaped, "i");
}

function classifyAddendums(addendums: string[]): { emergency?: string; medical?: string } {
  return {
    emergency: addendums.find((a) => /999|emergency|severe breathing|call/i.test(a)),
    medical: addendums.find((a) => /not medical advice|patient-reported/i.test(a)),
  };
}

function collectTextsToCheck(message: OutboundMessage): string[] {
  const texts: string[] = [message.content.text];
  const { content } = message;

  if (content.buttons) {
    for (const button of content.buttons) {
      texts.push(button.title);
    }
  }

  if (content.list) {
    for (const item of content.list) {
      texts.push(item.title);
      if (item.description) texts.push(item.description);
    }
  }

  if (content.templateVariables) {
    texts.push(...Object.values(content.templateVariables));
  }

  return texts.filter((t) => t.trim().length > 0);
}

function checkTextAgainstPatterns(
  text: string,
  patterns: RegExp[]
): Pick<SafetyResult, "approved" | "riskLevel" | "blockReason"> {
  for (const pattern of patterns) {
    if (pattern.test(text)) {
      return {
        approved: false,
        riskLevel: "high",
        blockReason: `Prohibited diagnostic or treatment language detected: ${pattern.source}`,
      };
    }
  }
  return { approved: true, riskLevel: "none" };
}

function buildRequiredAddendums(texts: string[], disease?: string): string[] {
  const combined = texts.join("\n");
  const rules = disease ? loadSafetyRules(disease) : null;
  const fromRag = rules?.requiredAddendums ?? [];
  const { emergency, medical } = classifyAddendums(fromRag);

  const addendums: string[] = [];

  if (emergency && /asthma|wheez|inhaler|breath|reliever|controller/i.test(combined)) {
    addendums.push(emergency);
  }

  if (medical && /health|symptom|medication|doctor|clinic|visit/i.test(combined)) {
    addendums.push(medical);
  }

  // Fallback for unknown disease or missing RAG rules.
  if (addendums.length === 0 && fromRag.length === 0) {
    if (/asthma|wheez|inhaler|breath|reliever|controller/i.test(combined)) {
      addendums.push(FALLBACK_EMERGENCY_ADDENDUM);
    }
    if (/health|symptom|medication|doctor|clinic|visit/i.test(combined)) {
      addendums.push(FALLBACK_MEDICAL_DISCLAIMER);
    }
  }

  return addendums;
}

function buildProhibitedPatterns(disease?: string): RegExp[] {
  const patterns = [...PROHIBITED_PATTERNS];
  const rules = disease ? loadSafetyRules(disease) : null;
  for (const phrase of rules?.prohibitedPhrases ?? []) {
    if (!phrase.trim()) continue;
    patterns.push(phraseToPattern(phrase));
  }
  return patterns;
}

export function safetyCheck(message: OutboundMessage, disease = "asthma"): SafetyResult {
  const texts = collectTextsToCheck(message);
  const result: SafetyResult = {
    approved: true,
    requiredAddendums: [],
    riskLevel: "none",
  };

  const prohibitedPatterns = buildProhibitedPatterns(disease);
  for (const text of texts) {
    const check = checkTextAgainstPatterns(text, prohibitedPatterns);
    if (!check.approved) {
      result.approved = false;
      result.riskLevel = check.riskLevel;
      result.blockReason = check.blockReason;
      return result;
    }
  }

  result.requiredAddendums = buildRequiredAddendums(texts, disease);

  return result;
}

export function loadSafetyRulesForDisease(disease: string): ReturnType<typeof loadSafetyRules> {
  return loadSafetyRules(disease);
}
