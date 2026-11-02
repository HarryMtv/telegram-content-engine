import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { LlmClient } from "../../src/llm/client.js";
import { MockLlmProvider } from "../../src/llm/provider.js";
import { calculateCallCost, DEFAULT_LLM_CONFIG } from "../../src/llm/pricing.js";

describe("LLM Client & Pricing (Task 2.1)", () => {
  it("правильно рассчитывает стоимость вызова по токенам и ценам", () => {
    const pricing = {
      model: "gpt-4o-mini",
      inputPricePerMillion: 0.15,
      outputPricePerMillion: 0.6,
    };
    // 1000 input tokens = 0.00015, 500 output tokens = 0.00030 -> total 0.00045
    const cost = calculateCallCost(1000, 500, pricing);
    expect(cost).toBe(0.00045);
  });

  it("выполняет вызов, валидирует Zod-схему и сохраняет вызов в llm_calls до возврата", async () => {
    const insertedRows: any[] = [];
    const mockDb: any = {
      insertInto: vi.fn(() => ({
        values: vi.fn((vals) => ({
          returning: vi.fn(() => ({
            executeTakeFirstOrThrow: vi.fn(async () => {
              const row = { id: "test-call-uuid", ...vals };
              insertedRows.push(row);
              return row;
            }),
          })),
        })),
      })),
    };

    const provider = new MockLlmProvider();
    provider.setResponse({
      text: JSON.stringify({ relevance: 0.85, reason: "Good AI article" }),
      inputTokens: 1200,
      outputTokens: 80,
    });

    const client = new LlmClient(mockDb, provider, DEFAULT_LLM_CONFIG);

    const schema = z.object({
      relevance: z.number(),
      reason: z.string(),
    });

    const result = await client.call({
      role: "cheap",
      stage: "triage",
      channelId: "11111111-2222-3333-4444-555555555555",
      messages: [{ role: "user", content: "Analyze this" }],
      schema,
    });

    expect(result.id).toBe("test-call-uuid");
    expect(result.data).toEqual({ relevance: 0.85, reason: "Good AI article" });
    expect(result.model).toBe("gpt-4o-mini");
    expect(result.inputTokens).toBe(1200);
    expect(result.outputTokens).toBe(80);
    expect(result.costUsd).toBeGreaterThan(0);

    // Проверяем, что в базу записано правильное состояние
    expect(insertedRows).toHaveLength(1);
    expect(insertedRows[0].stage).toBe("triage");
    expect(insertedRows[0].channel_id).toBe("11111111-2222-3333-4444-555555555555");
    expect(insertedRows[0].model).toBe("gpt-4o-mini");
    expect(insertedRows[0].input_tokens).toBe(1200);
    expect(insertedRows[0].output_tokens).toBe(80);
  });

  it("выбрасывает ошибку при несоответствии ответа Zod-схеме", async () => {
    const mockDb: any = {
      insertInto: vi.fn(() => ({
        values: vi.fn(() => ({
          returning: vi.fn(() => ({
            executeTakeFirstOrThrow: vi.fn(async () => ({ id: "1" })),
          })),
        })),
      })),
    };

    const provider = new MockLlmProvider();
    provider.setResponse({
      text: JSON.stringify({ relevance: "not-a-number", reason: 123 }),
    });

    const client = new LlmClient(mockDb, provider, DEFAULT_LLM_CONFIG);

    const schema = z.object({
      relevance: z.number(),
      reason: z.string(),
    });

    await expect(
      client.call({
        role: "cheap",
        stage: "triage",
        messages: [{ role: "user", content: "Test" }],
        schema,
      }),
    ).rejects.toThrow();
  });

  it("выбирает strong модель при роли strong", async () => {
    const mockDb: any = {
      insertInto: vi.fn(() => ({
        values: vi.fn((vals) => ({
          returning: vi.fn(() => ({
            executeTakeFirstOrThrow: vi.fn(async () => ({ id: "strong-call-id", ...vals })),
          })),
        })),
      })),
    };

    const provider = new MockLlmProvider();
    provider.setResponse({ text: "Rewritten post" });

    const client = new LlmClient(mockDb, provider, DEFAULT_LLM_CONFIG);

    const result = await client.call({
      role: "strong",
      stage: "strong_draft",
      messages: [{ role: "user", content: "Rewrite" }],
    });

    expect(result.model).toBe("gpt-4o");
    expect(provider.lastRequest?.model).toBe("gpt-4o");
  });
});
