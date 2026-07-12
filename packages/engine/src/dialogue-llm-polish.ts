import { createHash } from "node:crypto";
import type { LLMClient, LLMMessage } from "./llm.js";
import type { LlmAuditCallback } from "./perception.js";
import type { DialogueLocale } from "./dialogue-locales/index.js";

export interface PolishOptions {
  llmClient: LLMClient;
  onLlmCall?: LlmAuditCallback;
  locale?: DialogueLocale;
  intent?: "safety" | "closing" | "question" | "inform";
}

const POLISH_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const MAX_POLISHED_LENGTH = 320;

interface CacheEntry {
  text: string;
  expiresAt: number;
}

const polishCache = new Map<string, CacheEntry>();

function cacheKey(text: string, intent: PolishOptions["intent"], localeCode?: string): string {
  return createHash("sha256").update(`${text}:${intent ?? "inform"}:${localeCode ?? "en-GB"}`).digest("hex");
}

function getCached(key: string): string | undefined {
  const entry = polishCache.get(key);
  if (!entry) return undefined;
  if (Date.now() > entry.expiresAt) {
    polishCache.delete(key);
    return undefined;
  }
  return entry.text;
}

function setCached(key: string, text: string): void {
  polishCache.set(key, { text, expiresAt: Date.now() + POLISH_CACHE_TTL_MS });
}

function truncatePolished(text: string, maxLength: number = MAX_POLISHED_LENGTH): string {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength - 1) + "…";
}

export function resetPolishCache(): void {
  polishCache.clear();
}

/**
 * Optional LLM polish for outbound messages.
 *
 * Rules:
 * - Preserve meaning and safety-critical instructions.
 * - Do not add diagnosis, treatment advice, or emergency judgment.
 * - Keep the message in the same language as the input.
 * - Keep the output short and suitable for IM (hard cap at 320 chars).
 * - Return ONLY the polished message text.
 */
export async function polishMessage(text: string, options: PolishOptions): Promise<string> {
  const key = cacheKey(text, options.intent, options.locale?.code);
  const cached = getCached(key);
  if (cached !== undefined) {
    return cached;
  }

  const systemPrompt = `You are the final polish layer for a UK asthma follow-up assistant called CareMemory.
Your job is to rephrase a short outbound message so it sounds natural, warm, and conversational while keeping the exact same meaning and intent.

Rules:
1. NEVER add diagnosis, treatment advice, or medication instructions.
2. NEVER remove emergency instructions such as "call 999" or "follow your asthma action plan".
3. NEVER change the language of the message.
4. Keep the message concise (ideally under 300 characters) and suitable for WhatsApp.
5. Do not add sign-offs like "CareMemory Team" unless already present.
6. Preserve the capitalization of the pronoun "I".
7. Return ONLY the polished message text, with no quotes, no markdown, and no extra commentary.`;

  const localeHint = options.locale ? `The message should remain in ${options.locale.code}.` : "";
  const userPrompt = `Intent: ${options.intent ?? "inform"}\n${localeHint}\nMessage:\n${text}`;

  const messages: LLMMessage[] = [
    { role: "system", content: systemPrompt },
    { role: "user", content: userPrompt },
  ];

  const { content, usage } = await options.llmClient.complete(messages, { temperature: 0.3 });

  if (options.onLlmCall) {
    await options.onLlmCall(options.llmClient.modelName, messages, content, usage);
  }

  const polished = truncatePolished(content.trim());
  setCached(key, polished);
  return polished;
}
