import { describe, expect, it, vi } from "vitest";
import { runStage2Triage } from "../../src/pipeline/stage2.js";
import { LlmClient } from "../../src/llm/client.js";
import { MockLlmProvider } from "../../src/llm/provider.js";
import { DEFAULT_LLM_CONFIG } from "../../src/llm/pricing.js";

describe("Stage 2 — LLM Triage (Task 2.6)", () => {
  it("отправляет батч в LLM, парсит оценки и причины, ограничивает лимит выхода 5-8", async () => {
    const mockDb: any = {
      insertInto: vi.fn(() => ({
        values: vi.fn(() => ({
          returning: vi.fn(() => ({
            executeTakeFirstOrThrow: vi.fn(async () => ({ id: "triage-call-id" })),
          })),
        })),
      })),
    };

    const provider = new MockLlmProvider();
    provider.setResponse({
      text: JSON.stringify({
        evaluations: [
          { id: "item-1", relevance: 0.95, novelty: 0.85, reason: "Отличная новость про релиз модели" },
          { id: "item-2", relevance: 0.2, novelty: 0.1, reason: "Маркетинговый спам" },
          { id: "item-3", relevance: 0.8, novelty: 0.75, reason: "Интересный разбор архитектуры" },
        ],
      }),
      inputTokens: 800,
      outputTokens: 120,
    });

    const client = new LlmClient(mockDb, provider, DEFAULT_LLM_CONFIG);

    const candidates = [
      { id: "item-1", title: "New AI model", snippet: "OpenAI announced model" },
      { id: "item-2", title: "Buy our crypto course", snippet: "Discount today" },
      { id: "item-3", title: "Transformer architecture", snippet: "Deep dive" },
    ];

    const results = await runStage2Triage(
      client,
      candidates,
      "Берём технические новости про AI. Не берём спам и рекламу.",
      { maxOutput: 2 },
    );

    expect(results).toHaveLength(2);
    expect(results[0]!.id).toBe("item-1");
    expect(results[0]!.tlevanceScore).toBe(0.95);
    expect(results[0]!.triageReason).toBe("Отличная новость про релиз модели");

    expect(results[1]!.id).toBe("item-3");
    expect(results[1]!.tlevanceScore).toBe(0.8);

    // item-2 со слабым скором отсеян лимитом maxOutput
    expect(results.some((r) => r.id === "item-2")).toBe(false);
  });
});
