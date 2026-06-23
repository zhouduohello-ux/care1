export interface LLMMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface LLMClient {
  complete(messages: LLMMessage[], options?: { temperature?: number; responseFormat?: "json" }): Promise<string>;
}

export interface OpenAIConfig {
  apiKey: string;
  baseUrl?: string;
  model?: string;
  fallbackModel?: string;
  temperature?: number;
}

export function createOpenAIClient(config: OpenAIConfig): LLMClient {
  const baseUrl = config.baseUrl ?? "https://api.openai.com/v1";
  const model = config.model ?? "gpt-4o-mini";
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
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = data.choices?.[0]?.message?.content ?? "";
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
