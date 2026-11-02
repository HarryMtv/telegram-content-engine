import { describe, expect, it, vi } from "vitest";
import { generateLlmDraft } from "../../src/generation/llm-draft.js";
import { LlmClient } from "../../src/llm/client.js";
import { MockLlmProvider } from "../../src/llm/provider.js";
import { DEFAULT_LLM_CONFIG } from "../../src/llm/pricing.js";

describe("LLM Draft Generation (Task 2.10)", () => {
  it("генерирует черновик дешёвой моделью с включением FactSheet, few-shot и ссылки на первоисточник", async () => {
    let insertedDraft: any = null;

    const mockDb: any = {
      insertInto: vi.fn((table: string) => {
        if (table === "llm_calls") {
          return {
            values: vi.fn(() => ({
              returning: vi.fn(() => ({
                executeTakeFirstOrThrow: vi.fn(async () => ({ id: "call-draft-1" })),
              })),
            })),
          };
        }
        if (table === "drafts") {
          return {
            values: vi.fn((vals) => {
              insertedDraft = vals;
              return {
                returning: vi.fn(() => ({
                  executeTakeFirstOrThrow: vi.fn(async () => ({ id: "draft-uuid-1" })),
                })),
              };
            }),
          };
        }
        return {};
      }),
    };

    const provider = new MockLlmProvider();
    provider.setResponse({
      text: "Anthropic выпустила Claude 3.5 Sonnet. Модель работает в 2 раза быстрее.\n\nhttps://anthropic.com/sonnet",
      inputTokens: 1200,
      outputTokens: 150,
    });

    const client = new LlmClient(mockDb, provider, DEFAULT_LLM_CONFIG);

    const factSheet = {
      what_happened: "Anthropic released Claude 3.5 Sonnet",
      who: ["Anthropic"],
      numbers: { speedup: "2x" },
      primary_url: "https://anthropic.com/sonnet",
      confidence: 1.0,
      source_item_ids: ["item-1"],
    };

    const result = await generateLlmDraft(client, mockDb, {
      candidateId: "candidate-1",
      factSheetId: "factsheet-1",
      factSheet,
      format: { slug: "digest", targetLength: 500 },
      profile: { version: 1, styleGuide: "Пиши кратко и по делу", taboos: ["кликбейт"] },
      fewShotExamples: [{ text: "Предыдущий успешный пост канала" }],
      variantN: 1,
    });

    expect(result.id).toBe("draft-uuid-1");
    expect(result.text).toContain("https://anthropic.com/sonnet");
    expect(result.model).toBe("gpt-4o-mini");
    expect(insertedDraft.candidate_id).toBe("candidate-1");
    expect(insertedDraft.variant_n).toBe(1);

    // Проверяем, что промпт содержал taboos и few-shot
    const lastPrompt = provider.lastRequest?.messages[0]?.content ?? "";
    expect(lastPrompt).toContain("кликбейт");
    expect(lastPrompt).toContain("Предыдущий успешный пост канала");
  });

  it("автоматически добавляет ссылку на первоисточник, если модель забыла её вставить", async () => {
    const mockDb: any = {
      insertInto: vi.fn(() => ({
        values: vi.fn(() => ({
          returning: vi.fn(() => ({
            executeTakeFirstOrThrow: vi.fn(async () => ({ id: "draft-2" })),
          })),
        })),
      })),
    };

    const provider = new MockLlmProvider();
    // Модель вернула текст без ссылки
    provider.setResponse({ text: "Текст поста без ссылки в конце." });

    const client = new LlmClient(mockDb, provider, DEFAULT_LLM_CONFIG);

    const result = await generateLlmDraft(client, mockDb, {
      candidateId: "candidate-2",
      factSheetId: "factsheet-2",
      factSheet: {
        what_happened: "News",
        who: [],
        numbers: {},
        primary_url: "https://source.com/article",
        confidence: 1.0,
        source_item_ids: [],
      },
      format: { slug: "digest" },
      profile: {},
    });

    expect(result.text).toContain("https://source.com/article");
  });
});
