import { describe, expect, it, vi } from "vitest";
import { FactSheetSchema, generateFactSheet } from "../../src/generation/factsheet.js";
import { LlmClient } from "../../src/llm/client.js";
import { MockLlmProvider } from "../../src/llm/provider.js";
import { DEFAULT_LLM_CONFIG } from "../../src/llm/pricing.js";

describe("FactSheet Extraction & Schema (Task 2.8)", () => {
  it("валидирует корректный FactSheet по Zod-схеме", () => {
    const validData = {
      what_happened: "Anthropic выпустила Claude 3.5 Sonnet с улучшенными возможностями кодинга.",
      who: ["Anthropic", "Dario Amodei"],
      numbers: { benchmark: "92%", latency: "2x faster" },
      key_quote: "This is our most intelligent model yet.",
      why_it_matters: "Устанавливает новый стандарт для AI-разработки.",
      primary_url: "https://anthropic.com/news/claude-3-5-sonnet",
      confidence: 0.98,
      source_item_ids: ["item-1"],
    };

    const parsed = FactSheetSchema.safeParse(validData);
    expect(parsed.success).toBe(true);
  });

  it("генерирует FactSheet через LLM и сохраняет в таблицу fact_sheets", async () => {
    let insertedFactSheet: any = null;

    const mockDb: any = {
      insertInto: vi.fn((table: string) => {
        if (table === "llm_calls") {
          return {
            values: vi.fn(() => ({
              returning: vi.fn(() => ({
                executeTakeFirstOrThrow: vi.fn(async () => ({ id: "llm-call-1" })),
              })),
            })),
          };
        }
        if (table === "fact_sheets") {
          return {
            values: vi.fn((vals) => {
              insertedFactSheet = vals;
              return {
                returning: vi.fn(() => ({
                  executeTakeFirstOrThrow: vi.fn(async () => ({ id: "fact-sheet-uuid" })),
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
      text: JSON.stringify({
        what_happened: "Release of Postgres 17 with memory optimizations.",
        who: ["PostgreSQL Global Development Group"],
        numbers: { version: "17.0", speedup: "2x" },
        primary_url: "https://postgresql.org/about/news/postgres-17-released/",
        confidence: 1.0,
        source_item_ids: ["item-pg-1"],
      }),
      inputTokens: 1500,
      outputTokens: 200,
    });

    const client = new LlmClient(mockDb, provider, DEFAULT_LLM_CONFIG);

    const result = await generateFactSheet(
      client,
      mockDb,
      "story-pg-1",
      [
        {
          id: "item-pg-1",
          title: "PostgreSQL 17 Released",
          bodyText: "Full article text about pg 17 release and query performance improvements...",
          canonicalUrl: "https://postgresql.org/about/news/postgres-17-released/",
        },
      ],
      { channelId: "channel-1" },
    );

    expect(result.id).toBe("fact-sheet-uuid");
    expect(result.factSheet.what_happened).toContain("Postgres 17");
    expect(result.factSheet.numbers).toEqual({ version: "17.0", speedup: "2x" });
    expect(insertedFactSheet.story_id).toBe("story-pg-1");
    expect(insertedFactSheet.primary_url).toBe("https://postgresql.org/about/news/postgres-17-released/");
  });
});
