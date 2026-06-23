import type { OutboundMessage } from "@carememory/im-core";
import type { SafetyResult } from "./types.js";

const PROHIBITED_PATTERNS = [
  /you (have|are having) (an asthma attack|a severe attack|an attack)/i,
  /you should (increase|decrease|stop|start|change) (your medication|your inhaler|the dose)/i,
  /take \d+ puffs? (of|from) your/i,
  /you need (steroids|antibiotics|a nebulizer)/i,
  /your asthma is (severe|uncontrolled|life-threatening)/i,
];

export function safetyCheck(message: OutboundMessage): SafetyResult {
  const text = message.content.text;
  const result: SafetyResult = {
    approved: true,
    requiredAddendums: [],
    riskLevel: "none",
  };

  for (const pattern of PROHIBITED_PATTERNS) {
    if (pattern.test(text)) {
      result.approved = false;
      result.riskLevel = "high";
      result.blockReason = `Prohibited diagnostic or treatment language detected: ${pattern.source}`;
      return result;
    }
  }

  // Asthma-related messages must include emergency disclaimer
  if (/asthma|wheez|inhaler|breath|reliever|controller/i.test(text)) {
    result.requiredAddendums.push(
      "If you're having severe breathing problems, call 999 or follow your asthma action plan."
    );
  }

  // All medical-related outbound messages include disclaimer
  if (/health|symptom|medication|doctor|clinic|visit/i.test(text)) {
    result.requiredAddendums.push(
      "This is based on patient-reported information only and is not medical advice."
    );
  }

  return result;
}
