import { describe, expect, it, vi } from "vitest";
import { verifyFactSheet } from "../../src/generation/fact-check.js";
import { LlmClient } from "../../src/llm/client.js";
import { MockLlmProvider } from "../../src/llm/provider.js";
import { DEFAULT_LLM_CONFIG } from "../../src/llm/pricing.js";

describe("Fact Checking Verification (Task 2.9)", () => {
  it("подтверждает верный FactSheet и сохраняет высокую уверенность", async () => {
    let updatedConfidence: number | null = null;
    const mockDb: any = {
      insertInto: vi.fn(() => ({
        values: vi.fn(() => ({
          returning: vi.fn(() => ({
            executeTakeFirstOrThrow: vi.fn(async () => ({ id: "call-1" })),
          })),
        })),
      })),
      updateTable: vi.fn(() => ({
        set: vi.fn((vals) => {
          updatedConfidence = vals.confidence;
          return {
            where: vi.fn(() => ({
              execute: vi.fn(async () => []),
            })),
          };
        }),
      })),
    };

    const provider = new MockLlmProvider();
    provider.setResponse({
      text: JSON.stringify({
        passed: true,
        confidence: 1.0,
        discrepancies: [],
        notes: "Все числа и факты подтверждены текстом",
      }),
      inputTokens: 1000,
      outputTokens: 50,
    });

    const client = new LlmClient(mockDb, provider, DEFAULT_LLM_CONFIG);

    const factSheet = {
      what_happened: "Company raised 50M USD in Series B.",
      who: ["Acme Corp"],
      numbers: { amount: "50M" },
      primary_url: "https://example.com/raise",
      confidence: 1.0,
      source_item_ids: ["item-1"],
    };

    const result = await verifyFactSheet(
      client,
      mockDb,
      "fact-sheet-1",
      factSheet,
      [{ id: "item-1", title: "Acme raises 50M", bodyText: "Acme Corp closed $50M Series B today...", canonicalUrl: "https://example.com/raise" }],
    );

    expect(result.check.passed).toBe(true);
    expect(result.factSheet.confidence).toBe(1.0);
    expect(updatedConfidence).toBe(1.0);
  });

  it("понижает confidence при искажении числа и фиксирует расхождения", async () => {
    let updatedConfidence: number | null = null;
    const mockDb: any = {
      insertInto: vi.fn(() => ({
        values: vi.fn(() => ({
          returning: vi.fn(() => ({
            executeTakeFirstOrThrow: vi.fn(async () => ({ id: "call-2" })),
          })),
        })),
      })),
      updateTable: vi.fn(() => ({
        set: vi.fn((vals) => {
          updatedConfidence = vals.confidence;
          return {
            where: vi.fn(() => ({
              execute: vi.fn(async () => []),
            })),
          };
        }),
      })),
    };

    const provider = new MockLlmProvider();
    // Искажение числа: в FactSheet 500M, а в источнике было 50M
    provider.setResponse({
      text: JSON.stringify({
        passed: false,
        confidence: 0.4,
        discrepancies: ["В источнике указано $50M, а в FactSheet ошибочно указано $500M"],
        notes: "Несовпадение суммы раунда",
      }),
      inputTokens: 1000,
      outputTokens: 80,
    });

    const client = new LlmClient(mockDb, provider, DEFAULT_LLM_CONFIG);

    const flawedFactSheet = {
      what_happened: "Company raised 500M USD in Series B.",
      who: ["Acme Corp"],
      numbers: { amount: "500M" }, // Ошибка!
      primary_url: "https://example.com/raise",
      confidence: 1.0,
      source_item_ids: ["item-1"],
    };

    const result = await verifyFactSheet(
      client,
      mockDb,
      "fact-sheet-1",
      flawedFactSheet,
      [{ id: "item-1", title: "Acme raises 50M", bodyText: "Acme Corp closed $50M Series B today...", canonicalUrl: "https://example.com/raise" }],
    );

    expect(result.check.passed).toBe(false);
    expect(result.check.discrepancies).toHaveLength(1);
    expect(result.factSheet.confidence).toBeLessThanOrEqual(0.6);
    expect(updatedConfidence).toBeLessThanOrEqual(0.6);
  });
});
