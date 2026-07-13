import type { OutboundMessage } from "@carememory/im-core";
import type { LLMClient, LLMMessage } from "./llm.js";
import type { SafetyResult } from "./types.js";
import type { SafetyRuleSet } from "@carememory/rag";

const SAFETY_SYSTEM_PROMPT = `You are the safety classifier for CareMemory, a UK health-record assistant that communicates with patients via WhatsApp.

Your job is to review outbound messages and decide whether they are safe to send.

Rules:
1. Reject any message that diagnoses the patient, gives treatment advice, tells the patient to change medication/dose, or says they do/do not need medical care.
2. Reject any message that could be interpreted as emergency medical instruction instead of directing the patient to call 999 or follow their own asthma action plan.
3. Allowed: asking about symptoms, medication use, triggers, daily activities; offering a brief link; saying thank you; clarifying questions.
4. Append no addendums yourself — only classify.

Respond with a single JSON object containing exactly these fields:
- approved: boolean
- riskLevel: one of "none", "low", "medium", "high"
- blockReason: optional string explaining why if approved is false or riskLevel is high

Be conservative: when in doubt, set approved=false and riskLevel=high.`;

export interface LlmSafetyCheckInput {
  messages: OutboundMessage[];
  disease?: string;
  rules?: SafetyRuleSet;
}

function extractAllTexts(messages: OutboundMessage[]): string[] {
  const texts: string[] = [];
  for (const msg of messages) {
    texts.push(msg.content.text);
    if (msg.content.buttons) {
      for (const b of msg.content.buttons) texts.push(b.title);
    }
    if (msg.content.list) {
      for (const item of msg.content.list) {
        texts.push(item.title);
        if (item.description) texts.push(item.description);
      }
    }
    if (msg.content.templateVariables) {
      texts.push(...Object.values(msg.content.templateVariables));
    }
  }
  return texts.filter((t) => t.trim().length > 0);
}

function buildUserPrompt(input: LlmSafetyCheckInput): string {
  const { messages, disease = "asthma", rules } = input;
  const lines = [
    `Disease context: ${disease}`,
    "",
    "Must never say:",
    ...(rules?.prohibitedPhrases.length ? rules.prohibitedPhrases : ["- Any diagnosis or treatment advice based on patient-reported data"]),
    "",
    "Must always say (for context only; do not append):",
    ...(rules?.requiredAddendums.length ? rules.requiredAddendums : ["- This is based on patient-reported information only and is not medical advice."]),
    "",
    "Outbound messages to classify:",
    ...extractAllTexts(messages).map((t, i) => `${i + 1}. ${t}`),
    "",
    'Respond with JSON only: {"approved": boolean, "riskLevel": "none" | "low" | "medium" | "high", "blockReason": string?}',
  ];
  return lines.join("\n");
}

function parseLlmSafetyResponse(content: string): SafetyResult {
  const cleaned = content.trim().replace(/^```json\s*|\s*```$/g, "");
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    // Non-JSON response is treated as a fallback refusal to be safe.
    return { approved: false, riskLevel: "high", requiredAddendums: [], blockReason: "LLM safety response was not valid JSON" };
  }

  if (!parsed || typeof parsed !== "object") {
    return { approved: false, riskLevel: "high", requiredAddendums: [], blockReason: "LLM safety response was not a JSON object" };
  }

  const obj = parsed as Record<string, unknown>;
  const approved = obj.approved === true;
  const riskLevel = ["none", "low", "medium", "high"].includes(String(obj.riskLevel))
    ? (String(obj.riskLevel) as SafetyResult["riskLevel"])
    : "high";
  const blockReason = typeof obj.blockReason === "string" ? obj.blockReason : undefined;

  return { approved, riskLevel, requiredAddendums: [], blockReason };
}

export async function llmSafetyCheckAsync(
  input: LlmSafetyCheckInput,
  llmClient: LLMClient
): Promise<SafetyResult> {
  const messages: LLMMessage[] = [
    { role: "system", content: SAFETY_SYSTEM_PROMPT },
    { role: "user", content: buildUserPrompt(input) },
  ];

  const { content } = await llmClient.complete(messages, { temperature: 0.1, responseFormat: "json" });
  return parseLlmSafetyResponse(content);
}
