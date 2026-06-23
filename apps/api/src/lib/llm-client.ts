import { createOpenAIClient, type LLMClient } from "@carememory/engine";
import type { LlmModelType } from "@carememory/engine";

const DEFAULT_MODELS: Record<LlmModelType, string> = {
  perception: "gpt-4o-mini",
  planner: "gpt-4o-mini",
  dialogue: "gpt-4o-mini",
  safety: "gpt-4o-mini",
};

const clientCache = new Map<LlmModelType, LLMClient | undefined>();

function createClientForModel(modelType: LlmModelType): LLMClient | undefined {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return undefined;

  const envVar = `DEFAULT_${modelType.toUpperCase()}_MODEL`;
  const model = process.env[envVar] ?? DEFAULT_MODELS[modelType];

  return createOpenAIClient({
    apiKey,
    baseUrl: process.env.OPENAI_BASE_URL,
    model,
    fallbackModel: process.env.LLM_FALLBACK_MODEL,
    temperature: 0.3,
  });
}

export function getLlmClient(modelType: LlmModelType): LLMClient | undefined {
  if (!clientCache.has(modelType)) {
    clientCache.set(modelType, createClientForModel(modelType));
  }
  return clientCache.get(modelType);
}

export function createLlmClient(): LLMClient | undefined {
  return getLlmClient("perception");
}
