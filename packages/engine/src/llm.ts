import type { LlmModelType } from "./types.js";

export interface LLMMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface LLMClient {
  modelName: string;
  complete(
    messages: LLMMessage[],
    options?: { temperature?: number; responseFormat?: "json" }
  ): Promise<{ content: string; usage?: { promptTokens: number; completionTokens: number; totalTokens: number } }>;
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
 *   LLM_TIMEOUT_MS          — request timeout in milliseconds (default 30000)
 *   LLM_MAX_RETRIES         — max retries for the primary model (default 2)
 *   LLM_RETRY_BASE_DELAY_MS — base delay for exponential backoff (default 500)
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
  /** Request timeout in milliseconds. */
  timeoutMs: number;
  /** Maximum retry attempts for the primary model. */
  maxRetries: number;
  /** Base delay for exponential backoff in milliseconds. */
  retryBaseDelayMs: number;
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

  return {
    enabled,
    chat,
    reason,
    layers,
    timeoutMs: parseIntEnv("LLM_TIMEOUT_MS", 30000),
    maxRetries: parseIntEnv("LLM_MAX_RETRIES", 2),
    retryBaseDelayMs: parseIntEnv("LLM_RETRY_BASE_DELAY_MS", 500),
  };
}

// ── Client factory ─────────────────────────────────────────────────────

export interface OpenAIConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
  fallbackModel?: string;
  temperature?: number;
  /** Request timeout in milliseconds. */
  timeoutMs?: number;
  /** Maximum retry attempts for the primary model. */
  maxRetries?: number;
  /** Base delay for exponential backoff in milliseconds. */
  retryBaseDelayMs?: number;
}

export class LlmTimeoutError extends Error {
  constructor(message = "LLM request timed out") {
    super(message);
    this.name = "LlmTimeoutError";
  }
}

export class LlmRateLimitError extends Error {
  constructor(message = "LLM rate limit exceeded") {
    super(message);
    this.name = "LlmRateLimitError";
  }
}

export function createOpenAIClient(config: OpenAIConfig): LLMClient {
  const baseUrl = config.baseUrl;
  const model = config.model;
  const fallbackModel = config.fallbackModel;
  const temperature = config.temperature ?? 0.3;
  const timeoutMs = config.timeoutMs ?? parseIntEnv("LLM_TIMEOUT_MS", 30000);
  const maxRetries = config.maxRetries ?? parseIntEnv("LLM_MAX_RETRIES", 2);
  const retryBaseDelayMs = config.retryBaseDelayMs ?? parseIntEnv("LLM_RETRY_BASE_DELAY_MS", 500);

  async function callModel(
    messages: LLMMessage[],
    options?: { temperature?: number; responseFormat?: "json" },
    targetModel?: string
  ): Promise<{ content: string; usage?: { promptTokens: number; completionTokens: number; totalTokens: number } }> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
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
        signal: controller.signal,
      });

      if (!response.ok) {
        const text = await response.text();
        if (response.status === 429) {
          throw new LlmRateLimitError(`OpenAI API 429: ${text}`);
        }
        throw new Error(`OpenAI API ${response.status}: ${text}`);
      }

      const data = (await response.json()) as {
        choices?: Array<{ message?: { content?: string; reasoning_content?: string } }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
      };
      const msg = data.choices?.[0]?.message;
      const content = msg?.content || msg?.reasoning_content || "";
      const usage = data.usage
        ? {
            promptTokens: data.usage.prompt_tokens ?? 0,
            completionTokens: data.usage.completion_tokens ?? 0,
            totalTokens: data.usage.total_tokens ?? 0,
          }
        : undefined;
      return { content, usage };
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        throw new LlmTimeoutError(`LLM request timed out after ${timeoutMs}ms`);
      }
      throw err;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  async function callWithRetry(
    messages: LLMMessage[],
    options?: { temperature?: number; responseFormat?: "json" },
    targetModel?: string
  ): Promise<{ content: string; usage?: { promptTokens: number; completionTokens: number; totalTokens: number } }> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await callModel(messages, options, targetModel);
      } catch (err) {
        lastError = err;
        if (attempt === maxRetries || !isRetryableLlmError(err)) {
          throw err;
        }
        const delay = retryBaseDelayMs * 2 ** attempt;
        await sleep(delay);
      }
    }
    throw lastError;
  }

  return {
    modelName: model,
    async complete(messages, options) {
      try {
        return await callWithRetry(messages, options);
      } catch (err) {
        if (fallbackModel && isRetryableLlmError(err)) {
          return await callWithRetry(messages, options, fallbackModel);
        }
        throw err;
      }
    },
  };
}

function parseIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (Number.isNaN(parsed) || parsed < 0 || !Number.isInteger(parsed)) {
    console.warn(`[llm] Invalid ${name}="${raw}"; using fallback ${fallback}`);
    return fallback;
  }
  return parsed;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableLlmError(error: unknown): boolean {
  if (error instanceof LlmTimeoutError || error instanceof LlmRateLimitError) return true;
  if (!(error instanceof Error)) return false;
  const message = error.message.toLowerCase();
  return (
    message.includes("rate limit") ||
    message.includes("429") ||
    message.includes("timeout") ||
    message.includes("timed out") ||
    message.includes("500") ||
    message.includes("503") ||
    message.includes("502") ||
    message.includes("fetch failed") ||
    message.includes("econnreset") ||
    message.includes("econnrefused") ||
    message.includes("socket hang up") ||
    message.includes("networkerror")
  );
}

export function createStubClient(response: string): LLMClient {
  return {
    modelName: "stub",
    async complete() {
      return { content: response };
    },
  };
}
