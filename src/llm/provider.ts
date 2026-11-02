import type { LlmProvider, ChatMessage, ProviderResponse } from "./types.js";

export class MockLlmProvider implements LlmProvider {
  public lastRequest?: {
    model: string;
    messages: ChatMessage[];
    temperature?: number;
    maxTokens?: number;
    jsonMode?: boolean;
  };
  private nextResponse: ProviderResponse = {
    text: "{}",
    inputTokens: 100,
    outputTokens: 50,
  };

  setResponse(response: Partial<ProviderResponse> & { text: string }): void {
    this.nextResponse = {
      text: response.text,
      inputTokens: response.inputTokens ?? 100,
      outputTokens: response.outputTokens ?? 50,
    };
  }

  async chat(options: {
    model: string;
    messages: ChatMessage[];
    temperature?: number;
    maxTokens?: number;
    jsonMode?: boolean;
  }): Promise<ProviderResponse> {
    this.lastRequest = options;
    return this.nextResponse;
  }
}

export class HttpOpenAiProvider implements LlmProvider {
  constructor(
    private readonly apiKey: string,
    private readonly baseUrl: string = "https://api.openai.com/v1",
  ) {}

  async chat(options: {
    model: string;
    messages: ChatMessage[];
    temperature?: number;
    maxTokens?: number;
    jsonMode?: boolean;
  }): Promise<ProviderResponse> {
    const url = `${this.baseUrl.replace(/\/+$/, "")}/chat/completions`;
    const body: Record<string, unknown> = {
      model: options.model,
      messages: options.messages,
      temperature: options.temperature ?? 0.3,
    };
    const isThinkingModel =
      options.model.includes("pro") ||
      options.model.includes("reasoner") ||
      options.model.includes("r1") ||
      options.model.startsWith("o1") ||
      options.model.startsWith("o3");

    if (isThinkingModel) {
      body.thinking = { type: "enabled" };
      body.reasoning_effort = "high";
    }

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${this.apiKey}`,
      "HTTP-Referer": "https://github.com/telegram-content-engine",
      "X-Title": "Telegram Content Engine",
    };

    let lastError: Error | null = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const res = await fetch(url, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(90_000),
        });

        if (!res.ok) {
          const errText = await res.text().catch(() => "");
          if (res.status === 429 || res.status >= 500) {
            await new Promise((r) => setTimeout(r, attempt * 2000));
            continue;
          }
          throw new Error(`LLM provider HTTP ${res.status}: ${errText.slice(0, 300)}`);
        }

        const data = (await res.json()) as {
          choices: Array<{ message: { content?: string | null; reasoning_content?: string } }>;
          usage?: { prompt_tokens?: number; completion_tokens?: number };
        };

        const msg = data.choices[0]?.message;
        const text = msg?.content ?? msg?.reasoning_content ?? "";
        return {
          text,
          inputTokens: data.usage?.prompt_tokens ?? 0,
          outputTokens: data.usage?.completion_tokens ?? 0,
        };
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        if (attempt < 3) {
          await new Promise((r) => setTimeout(r, attempt * 2000));
        }
      }
    }

    throw lastError ?? new Error("LLM request failed after 3 attempts");
  }
}
