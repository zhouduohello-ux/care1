import type { OutboundMessage } from "@carememory/im-core";
import type { LLMClient, LLMMessage } from "./llm.js";
import type { SafetyResult } from "./types.js";
import type { SafetyRuleSet } from "@carememory/rag";
import crypto from "node:crypto";

const SAFETY_SYSTEM_PROMPT = `You are the safety classifier for CareMemory, a UK health-record assistant that communicates with patients via WhatsApp.

Your job is to review outbound messages and decide whether they are safe to send.

Rules:
1. Reject any message that diagnoses the patient, gives treatment advice, tells the patient to change medication/dose, or says they do/do not need medical care.
2. Reject any message that could be interpreted as emergency medical instruction instead of directing the patient to call 999 or follow their own asthma action plan.
3. Allowed: asking about symptoms, medication use, triggers, daily activities; offering a brief link; saying thank you; clarifying questions; reminding the patient to speak to their own healthcare team.
4. Append no addendums yourself — only classify.

Examples:
- Message: "How many times did you use your reliever inhaler today?" -> {"approved": true, "riskLevel": "none"}
- Message: "You should take 2 puffs of your reliever now." -> {"approved": false, "riskLevel": "high", "blockReason": "Gives specific treatment instructions"}
- Message: "If your symptoms are severe, call 999 or follow your asthma action plan." -> {"approved": true, "riskLevel": "low"}
- Message: "Your asthma is uncontrolled; you need steroids." -> {"approved": false, "riskLevel": "high", "blockReason": "Diagnoses and prescribes treatment"}
- Message: "Thanks for letting me know. Here is your Brief link." -> {"approved": true, "riskLevel": "none"}

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
  const jsonText = extractJsonObject(content);
  if (!jsonText) {
    return { approved: false, riskLevel: "high", requiredAddendums: [], blockReason: "LLM safety response did not contain a valid JSON object" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
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

/**
 * Extract the first top-level JSON object from the LLM response.
 * Handles markdown fences and explanatory text before/after the JSON.
 * Returns undefined if no well-formed object is found.
 */
function extractJsonObject(content: string): string | undefined {
  const cleaned = content.trim().replace(/^```json\s*|\s*```$/g, "");
  const firstBrace = cleaned.indexOf("{");
  if (firstBrace === -1) return undefined;

  let depth = 0;
  let inString = false;
  let escape = false;

  for (let i = firstBrace; i < cleaned.length; i++) {
    const ch = cleaned[i];
    if (inString) {
      if (escape) {
        escape = false;
        continue;
      }
      if (ch === "\\") {
        escape = true;
        continue;
      }
      if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "{") {
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0) {
        return cleaned.slice(firstBrace, i + 1);
      }
    }
  }

  return undefined;
}

// ── In-memory result cache ─────────────────────────────────────────────
// Caching classifier results avoids repeated LLM calls for identical outbound
// batches (common for system/fallback messages) and keeps the safety gate fast.

const DEFAULT_CACHE_TTL_MS = 5 * 60 * 1000;
const DEFAULT_MAX_ENTRIES = 1000;

interface CacheEntry {
  result: SafetyResult;
  expiresAt: number;
}

const resultCache = new Map<string, CacheEntry>();

function parseCacheTtlMs(): number {
  const raw = process.env.SAFETY_LLM_CACHE_TTL_MS;
  if (!raw) return DEFAULT_CACHE_TTL_MS;
  const parsed = Number(raw);
  if (Number.isNaN(parsed) || parsed < 0) {
    console.warn(`[safety-llm] Invalid SAFETY_LLM_CACHE_TTL_MS="${raw}"; using fallback ${DEFAULT_CACHE_TTL_MS}`);
    return DEFAULT_CACHE_TTL_MS;
  }
  return parsed;
}

function parseMaxCacheEntries(): number {
  const raw = process.env.SAFETY_LLM_CACHE_MAX_ENTRIES;
  if (!raw) return DEFAULT_MAX_ENTRIES;
  const parsed = Number(raw);
  if (Number.isNaN(parsed) || parsed < 1 || !Number.isInteger(parsed)) {
    console.warn(`[safety-llm] Invalid SAFETY_LLM_CACHE_MAX_ENTRIES="${raw}"; using fallback ${DEFAULT_MAX_ENTRIES}`);
    return DEFAULT_MAX_ENTRIES;
  }
  return parsed;
}

function buildCacheKey(input: LlmSafetyCheckInput): string {
  const payload = JSON.stringify({
    disease: input.disease,
    texts: extractAllTexts(input.messages),
    prohibitedPhrases: input.rules?.prohibitedPhrases ?? [],
    requiredAddendums: input.rules?.requiredAddendums ?? [],
  });
  return crypto.createHash("sha256").update(payload).digest("hex");
}

function getCachedResult(key: string): SafetyResult | undefined {
  const entry = resultCache.get(key);
  if (!entry) return undefined;
  if (Date.now() > entry.expiresAt) {
    resultCache.delete(key);
    return undefined;
  }
  return entry.result;
}

function setCachedResult(key: string, result: SafetyResult): void {
  const maxEntries = parseMaxCacheEntries();
  if (resultCache.size >= maxEntries) {
    const oldest = resultCache.keys().next().value;
    if (oldest !== undefined) {
      resultCache.delete(oldest);
    }
  }
  resultCache.set(key, { result, expiresAt: Date.now() + parseCacheTtlMs() });
}

/** Clear the classifier result cache. Exported for tests. */
export function clearSafetyLlmCache(): void {
  resultCache.clear();
}

export async function llmSafetyCheckAsync(
  input: LlmSafetyCheckInput,
  llmClient: LLMClient
): Promise<SafetyResult> {
  const key = buildCacheKey(input);
  const cached = getCachedResult(key);
  if (cached) {
    return cached;
  }

  const messages: LLMMessage[] = [
    { role: "system", content: SAFETY_SYSTEM_PROMPT },
    { role: "user", content: buildUserPrompt(input) },
  ];

  const { content } = await llmClient.complete(messages, { temperature: 0.1, responseFormat: "json" });
  const result = parseLlmSafetyResponse(content);
  setCachedResult(key, result);
  return result;
}
