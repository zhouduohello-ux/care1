import type { OutboundMessage } from "@carememory/im-core";
import type { SafetyResult } from "./types.js";
import { loadSafetyRules } from "@carememory/rag";

interface PatternRule {
  pattern: RegExp;
  except?: RegExp;
}

const PROHIBITED_RULES: PatternRule[] = [
  { pattern: /you (have|are having) (an asthma attack|a severe attack|an attack)/i },
  { pattern: /you should (increase|decrease|stop|start|change) (your medication|your inhaler|the dose)/i },
  {
    pattern: /take \d+ puffs? (of|from) your/i,
    except: /\b(how many|did you|do you|have you)\b.*\btake \d+ puffs?\b/i,
  },
  { pattern: /you need (steroids|antibiotics|a nebulizer)/i },
  { pattern: /your asthma is (severe|uncontrolled|life-threatening)/i },
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
  rules: PatternRule[]
): Pick<SafetyResult, "approved" | "riskLevel" | "blockReason"> {
  for (const rule of rules) {
    if (rule.pattern.test(text)) {
      if (rule.except && rule.except.test(text)) {
        continue;
      }
      return {
        approved: false,
        riskLevel: "high",
        blockReason: `Prohibited diagnostic or treatment language detected: ${rule.pattern.source}`,
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

function buildProhibitedPatterns(disease?: string): PatternRule[] {
  const rules: PatternRule[] = [...PROHIBITED_RULES];
  const ragRules = disease ? loadSafetyRules(disease) : null;
  for (const phrase of ragRules?.prohibitedPhrases ?? []) {
    if (!phrase.trim()) continue;
    rules.push({ pattern: phraseToPattern(phrase) });
  }
  return rules;
}

export function safetyCheck(message: OutboundMessage, disease = "asthma"): SafetyResult {
  const texts = collectTextsToCheck(message);
  const result: SafetyResult = {
    approved: true,
    requiredAddendums: [],
    riskLevel: "none",
  };

  const prohibitedRules = buildProhibitedPatterns(disease);
  for (const text of texts) {
    const check = checkTextAgainstPatterns(text, prohibitedRules);
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

export const SAFETY_FALLBACK_TEXT =
  "I'm not able to answer that in a safe way. Please speak to your healthcare team if you need advice.";

export function applySafetyAction(
  messages: OutboundMessage[],
  summary: SafetyResult
): { messages: OutboundMessage[]; summary: SafetyResult } {
  // Current rule-based checker only produces approved=false when risk is high.
  // This path is for future LLM-based classifiers that may return approved=true
  // with an elevated risk level — in that case we still abort the batch.
  if (summary.approved && summary.riskLevel === "high") {
    const first = messages[0];
    const fallback: OutboundMessage = {
      userId: first?.userId ?? "",
      conversationContext: { requiresSession: true, priority: "urgent" },
      content: { type: "text", text: SAFETY_FALLBACK_TEXT },
    };
    return {
      messages: [fallback],
      summary: {
        ...summary,
        approved: false,
        blockReason: summary.blockReason ?? "Outbound risk level high after safety review",
      },
    };
  }

  return { messages, summary };
}

export function loadSafetyRulesForDisease(disease: string): ReturnType<typeof loadSafetyRules> {
  return loadSafetyRules(disease);
}
