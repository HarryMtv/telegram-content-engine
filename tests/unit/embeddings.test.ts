import { describe, expect, it, vi } from "vitest";
import { MockEmbeddingProvider } from "../../src/embeddings/mock.js";
import {
  formatItemForEmbedding,
  vectorToString,
  embedPendingItems,
} from "../../src/embeddings/service.js";

describe("Embedding Provider & Batch Job (Task 2.2)", () => {
  it("MockEmbeddingProvider генерирует 1024-мерные нормализованные векторы", async () => {
    const provider = new MockEmbeddingProvider();
    const [vec] = await provider.embed(["OpenAI releases new model"]);

    expect(vec).toBeDefined();
    expect(vec!.length).toBe(1024);
    // Проверка L2 длины
    const length = Math.sqrt(vec!.reduce((acc, v) => acc + v * v, 0));
    expect(length).toBeCloseTo(1.0, 3);
  });

  it("форматирует текст для эмбеддинга объединяя заголовок и сниппет", () => {
    const text = formatItemForEmbedding("Заголовок новости", "Длинный текст статьи о разработке...");
    expect(text).toBe("Заголовок новости\n\nДлинный текст статьи о разработке...");
  });

  it("преобразует массив чисел в строковый формат pgvector [v1,v2,...]", () => {
    expect(vectorToString([0.1, -0.2, 0.35])).toBe("[0.1,-0.2,0.35]");
  });

  it("embedPendingItems находит материалы без эмбеддингов, векторизует и сохраняет", async () => {
    const mockItems = [
      { id: "item-1", title: "AI breakthrough", body_text: "Details about breakthrough" },
      { id: "item-2", title: "New compiler", body_text: "Fast compiler released" },
    ];

    const updatedMap = new Map<string, string>();

    const mockDb: any = {
      selectFrom: vi.fn(() => ({
        select: vi.fn(() => ({
          where: vi.fn(() => ({
            where: vi.fn(() => ({
              orderBy: vi.fn(() => ({
                limit: vi.fn(() => ({
                  execute: vi.fn(async () => mockItems),
                })),
              })),
            })),
          })),
        })),
      })),
      updateTable: vi.fn(() => ({
        set: vi.fn((vals) => ({
          where: vi.fn((_col, _op, id) => ({
            execute: vi.fn(async () => {
              updatedMap.set(id, vals.embedding);
              return [{ numUpdatedRows: 1n }];
            }),
          })),
        })),
      })),
    };

    const provider = new MockEmbeddingProvider();
    const res = await embedPendingItems(mockDb, provider, 10);

    expect(res.processed).toBe(2);
    expect(res.itemIds).toEqual(["item-1", "item-2"]);
    expect(provider.callCount).toBe(1);
    expect(updatedMap.size).toBe(2);
    expect(updatedMap.has("item-1")).toBe(true);
    expect(updatedMap.has("item-2")).toBe(true);
  });
});
