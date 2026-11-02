import { describe, expect, it, vi } from "vitest";
import { resolveRoleConfig, KNOWN_MODELS } from "../../src/llm/config.js";
import { createLlmClient } from "../../src/llm/factory.js";
import { createEmbeddingProvider } from "../../src/embeddings/factory.js";
import { loadConfig } from "../../src/config.js";
import { MockLlmProvider } from "../../src/llm/provider.js";

describe("Configurable Models & Providers", () => {
  it("разрешает дефолтные модели и цены OpenAI для cheap и strong", () => {
    const cheap = resolveRoleConfig("cheap", undefined, "sk-test-key");
    expect(cheap.model).toBe("gpt-4o-mini");
    expect(cheap.baseUrl).toBe("https://api.openai.com/v1");
    expect(cheap.pricing.inputPricePerMillion).toBe(0.15);
    expect(cheap.pricing.outputPricePerMillion).toBe(0.60);

    const strong = resolveRoleConfig("strong", undefined, "sk-test-key");
    expect(strong.model).toBe("gpt-4o");
    expect(strong.pricing.inputPricePerMillion).toBe(2.50);
    expect(strong.pricing.outputPricePerMillion).toBe(10.00);
  });

  it("поддерживает альтернативных провайдеров (DeepSeek, OpenRouter, Groq) с их ценами", () => {
    const deepseek = resolveRoleConfig("cheap", {
      provider: "deepseek",
      model: "deepseek-chat",
      apiKey: "ds-key",
    });
    expect(deepseek.baseUrl).toBe("https://api.deepseek.com/v1");
    expect(deepseek.pricing.inputPricePerMillion).toBe(0.14);
    expect(deepseek.pricing.outputPricePerMillion).toBe(0.28);

    const openrouter = resolveRoleConfig("strong", {
      provider: "openrouter",
      model: "anthropic/claude-3.5-sonnet",
      apiKey: "or-key",
    });
    expect(openrouter.baseUrl).toBe("https://openrouter.ai/api/v1");
    expect(openrouter.pricing.inputPricePerMillion).toBe(3.00);
  });

  it("createLlmClient создаёт клиент с независимыми провайдерами для cheap и strong ролей", async () => {
    const mockDb: any = {
      insertInto: vi.fn(() => ({
        values: vi.fn(() => ({
          returning: vi.fn(() => ({
            executeTakeFirstOrThrow: vi.fn(async () => ({ id: "audit-1" })),
          })),
        })),
      })),
    };

    const client = createLlmClient(mockDb, {
      cheap: { provider: "mock", model: "gpt-4o-mini" },
      strong: { provider: "mock", model: "gpt-4o" },
    });

    const resCheap = await client.call({
      role: "cheap",
      stage: "triage",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(resCheap.model).toBe("gpt-4o-mini");

    const resStrong = await client.call({
      role: "strong",
      stage: "strong_draft",
      messages: [{ role: "user", content: "rewrite" }],
    });
    expect(resStrong.model).toBe("gpt-4o");
  });

  it("createEmbeddingProvider создаёт нужный провайдер (cohere / openai / mock)", () => {
    const cohere = createEmbeddingProvider({ provider: "cohere", apiKey: "coh-key" });
    expect(cohere.dimensions).toBe(1024);

    const openai = createEmbeddingProvider({ provider: "openai", apiKey: "sk-key", model: "text-embedding-3-small" });
    expect(openai.dimensions).toBe(1024);

    const mock = createEmbeddingProvider({ provider: "mock" });
    expect(mock.dimensions).toBe(1024);
  });

  it("loadConfig считывает кастомные модели и провайдеры из env", () => {
    const baseEnv = {
      DATABASE_URL: "postgresql://postgres:pass@localhost:5432/postgres",
      TELEGRAM_BOT_TOKEN: "1234567890:ABCDEF1234567890",
      TELEGRAM_CHANNEL_CHAT_ID: "-1001234567890",
      TELEGRAM_OWNER_CHAT_ID: "123456789",
      TELEGRAM_WEBHOOK_SECRET: "secret123456",
    };

    const cfg = loadConfig({
      ...baseEnv,
      LLM_CHEAP_PROVIDER: "deepseek",
      LLM_CHEAP_MODEL: "deepseek-chat",
      LLM_STRONG_MODEL: "gpt-4.5-preview",
      EMBEDDING_PROVIDER: "openai",
    });

    expect(cfg.llmCheapProvider).toBe("deepseek");
    expect(cfg.llmCheapModel).toBe("deepseek-chat");
    expect(cfg.llmStrongModel).toBe("gpt-4.5-preview");
    expect(cfg.embeddingProvider).toBe("openai");
  });
});
