import type { LLMClient, LLMMessage } from "./llm.js";
import type { LlmAuditCallback } from "./perception.js";
import type { DialogueLocale } from "./dialogue-locales/index.js";

export interface PolishOptions {
  llmClient: LLMClient;
  onLlmCall?: LlmAuditCallback;
  locale?: DialogueLocale;
  intent?: "safety" | "closing" | "question" | "inform";
}

/**
 * Optional LLM polish for outbound messages.
 *
 * Rules:
 * - Preserve meaning and safety-critical instructions.
 * - Do not add diagnosis, treatment advice, or emergency judgment.
 * - Keep the message in the same language as the input.
 * - Keep the output short and suitable for IM (preferably under 300 chars).
 * - Return ONLY the polished message text.
 */
export async function polishMessage(text: string, options: PolishOptions): Promise<string> {
  const systemPrompt = `You are the final polish layer for a UK asthma follow-up assistant called CareMemory.
Your job is to rephrase a short outbound message so it sounds natural, warm, and conversational while keeping the exact same meaning and intent.

Rules:
1. NEVER add diagnosis, treatment advice, or medication instructions.
2. NEVER remove emergency instructions such as "call 999" or "follow your asthma action plan".
3. NEVER change the language of the message.
4. Keep the message concise (ideally under 300 characters) and suitable for WhatsApp.
5. Do not add sign-offs like "CareMemory Team" unless already present.
6. Return ONLY the polished message text, with no quotes, no markdown, and no extra commentary.`;

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

  return content.trim();
}
