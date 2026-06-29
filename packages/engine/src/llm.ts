import type { LlmModelType } from "./types.js";

export interface LLMMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface LLMClient {
  complete(messages: LLMMessage[], options?: { temperature?: number; responseFormat?: "json" }): Promise<string>;
}

// ── Unified LLM Configuration ──────────────────────────────────────────

/** Provider-level configuration: API credentials + default model. */
export interface LLMProviderConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
  fallbackModel?: string;
}

/** Per-layer overrides (model is optional — falls back to provider default). */
export interface LLMLayerConfig {
  model?: string;
  temperature: number;
}

/**
 * Maps each engine layer to its provider ("chat" or "reason").
 *
 *   perception  → chat
 *   planner     → reason
 *   dialogue    → chat
 *   safety      → chat
 */
export function layerProvider(layer: LlmModelType): "chat" | "reason" {
  return layer === "planner" ? "reason" : "chat";
}

/**
 * Single source of truth for all LLM settings in CareMemory.
 *
 * Usage: call `loadLLMConfig()` once at startup, pass `llmConfig` into
 * `EngineContext`. The engine internally creates the right `LLMClient`
 * per layer with caching.
 *
 * Environment variables (new `LLM_CHAT_*` / `LLM_REASON_*` names preferred;
 * old global `LLM_*` names work as fallback for both providers):
 *
 *   LLM_CHAT_API_KEY        — API key for chat provider
 *   LLM_CHAT_BASE_URL       — base URL for chat provider
 *   LLM_CHAT_MODEL          — default model for chat layers
 *
 *   LLM_REASON_API_KEY      — API key for reason provider
 *   LLM_REASON_BASE_URL     — base URL for reason provider
 *   LLM_REASON_MODEL        — default model for reason layers
 *
 *   LLM_FALLBACK_MODEL      — fallback model when primary fails (both providers)
 *
 *   LLM_MODEL_<LAYER>       — per-layer model override (PERCEPTION, PLANNER, …)
 *   LLM_TEMPERATURE         — global default temperature (default 0.3)
 *   LLM_TEMPERATURE_<LAYER> — per-layer temperature override
 */
export interface LLMConfig {
  /** Whether LLM is enabled at all (requires at least one provider apiKey). */
  enabled: boolean;
  chat: LLMProviderConfig;
  reason: LLMProviderConfig;
  /** Per-layer model (optional) and temperature settings. */
  layers: Record<LlmModelType, LLMLayerConfig>;
}

/**
 * Read all LLM-relevant environment variables and produce a single
 * `LLMConfig` object. No hardcoded model defaults — whatever you write in
 * the env is what gets used. Falls back from provider-specific vars to
 * old-style global vars for backward compatibility.
 */
export function loadLLMConfig(): LLMConfig {
  // Old-style global vars (backward compatibility)
  const globalApiKey = process.env.LLM_API_KEY ?? process.env.OPENAI_API_KEY ?? "";
  const globalBaseUrl = process.env.LLM_BASE_URL ?? process.env.OPENAI_BASE_URL ?? "";
  const globalModel = process.env.LLM_DEFAULT_MODEL ?? "";
  const globalTemp = process.env.LLM_TEMPERATURE ? Number(process.env.LLM_TEMPERATURE) : undefined;
  const globalFallback = process.env.LLM_FALLBACK_MODEL;

  // Provider-specific vars, falling back to global vars
  function providerConfig(prefix: "CHAT" | "REASON"): LLMProviderConfig {
    return {
      apiKey: process.env[`LLM_${prefix}_API_KEY`] ?? globalApiKey,
      baseUrl: process.env[`LLM_${prefix}_BASE_URL`] ?? globalBaseUrl,
      model: process.env[`LLM_${prefix}_MODEL`] ?? globalModel,
      fallbackModel: globalFallback,
    };
  }

  // Per-layer model override (optional)
  function layerModel(layer: LlmModelType): string | undefined {
    const key = `LLM_MODEL_${layer.toUpperCase()}`;
    const oldKey = `DEFAULT_${layer.toUpperCase()}_MODEL`;
    return process.env[key] ?? process.env[oldKey] ?? undefined;
  }

  // Per-layer temperature
  function layerTemp(layer: LlmModelType): number {
    const key = `LLM_TEMPERATURE_${layer.toUpperCase()}`;
    if (process.env[key]) return Number(process.env[key]);
    return globalTemp ?? 0.3;
  }

  const chat = providerConfig("CHAT");
  const reason = providerConfig("REASON");

  const layers = {
    perception: { model: layerModel("perception"), temperature: layerTemp("perception") },
    planner:    { model: layerModel("planner"),    temperature: layerTemp("planner") },
    dialogue:   { model: layerModel("dialogue"),   temperature: layerTemp("dialogue") },
    safety:     { model: layerModel("safety"),     temperature: layerTemp("safety") },
  } satisfies Record<LlmModelType, LLMLayerConfig>;

  // Enabled if at least one provider has an API key
  const enabled = !!(chat.apiKey || reason.apiKey);

  return { enabled, chat, reason, layers };
}

// ── Client factory ─────────────────────────────────────────────────────

export interface OpenAIConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
  fallbackModel?: string;
  temperature?: number;
}

export function createOpenAIClient(config: OpenAIConfig): LLMClient {
  const baseUrl = config.baseUrl;
  const model = config.model;
  const fallbackModel = config.fallbackModel;
  const temperature = config.temperature ?? 0.3;

  async function callModel(messages: LLMMessage[], options?: { temperature?: number; responseFormat?: "json" }, targetModel?: string): Promise<string> {
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: targetModel ?? model,
        messages,
        temperature: options?.temperature ?? temperature,
        response_format: options?.responseFormat === "json" ? { type: "json_object" } : undefined,
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`OpenAI API ${response.status}: ${text}`);
    }

    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: string; reasoning_content?: string } }>;
    };
    const msg = data.choices?.[0]?.message;
    const content = msg?.content || msg?.reasoning_content || "";
    return content;
  }

  return {
    async complete(messages, options) {
      try {
        return await callModel(messages, options);
      } catch (err) {
        if (fallbackModel && isRetryableLlmError(err)) {
          return await callModel(messages, options, fallbackModel);
        }
        throw err;
      }
    },
  };
}

function isRetryableLlmError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const message = error.message.toLowerCase();
  return (
    message.includes("rate limit") ||
    message.includes("429") ||
    message.includes("timeout") ||
    message.includes("500") ||
    message.includes("503") ||
    message.includes("502") ||
    message.includes("fetch failed")
  );
}

export function createStubClient(response: string): LLMClient {
  return {
    async complete() {
      return response;
    },
  };
}
