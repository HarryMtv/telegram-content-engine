import { describe, expect, it, vi } from "vitest";
import {
  cosineSimilarity,
  updateCentroid,
  calculateVelocity,
  clusterItemIntoStory,
} from "../../src/pipeline/clustering.js";

describe("Incremental Story Clustering (Task 2.3)", () => {
  it("считает косинусную близость между векторами", () => {
    const v1 = [1, 0, 0];
    const v2 = [1, 0, 0];
    const v3 = [0, 1, 0];
    const v4 = [0.8, 0.6, 0];

    expect(cosineSimilarity(v1, v2)).toBe(1);
    expect(cosineSimilarity(v1, v3)).toBe(0);
    expect(cosineSimilarity(v1, v4)).toBeCloseTo(0.8, 4);
  });

  it("корректно обновляет центроид через бегущее среднее с нормализацией", () => {
    const c0 = [1, 0, 0];
    const vNew = [0, 1, 0];
    // при count=1, среднее (1 + 0)/2 = 0.5, (0 + 1)/2 = 0.5 -> нормированное: [0.707107, 0.707107, 0]
    const updated = updateCentroid(c0, vNew, 1);
    expect(updated[0]).toBeCloseTo(0.707107, 4);
    expect(updated[1]).toBeCloseTo(0.707107, 4);
    expect(updated[2]).toBe(0);
  });

  it("рассчитывает velocity (материалов в час)", () => {
    const t1 = new Date("2026-08-25T00:00:00Z");
    const t2 = new Date("2026-08-25T02:00:00Z"); // 2 часа
    const vel = calculateVelocity(6, t1, t2);
    expect(vel).toBe(3.0); // 6 items / 2 hours = 3 items/hr
  });

  it("создаёт новую Story, если в окне нет похожих сюжетов", async () => {
    const mockDb: any = {
      selectFrom: vi.fn(() => ({
        select: vi.fn(() => ({
          where: vi.fn(() => ({
            where: vi.fn(() => ({
              orderBy: vi.fn(() => ({
                limit: vi.fn(() => ({
                  executeTakeFirst: vi.fn(async () => undefined), // нет похожих
                })),
              })),
            })),
          })),
        })),
      })),
      insertInto: vi.fn(() => ({
        values: vi.fn(() => ({
          returning: vi.fn(() => ({
            executeTakeFirstOrThrow: vi.fn(async () => ({ id: "new-story-id" })),
          })),
        })),
      })),
      updateTable: vi.fn(() => ({
        set: vi.fn(() => ({
          where: vi.fn(() => ({
            execute: vi.fn(async () => []),
          })),
        })),
      })),
    };

    const res = await clusterItemIntoStory(
      mockDb,
      {
        id: "item-1",
        sourceId: "src-1",
        embedding: [0.5, 0.5],
        discoveredAt: new Date("2026-08-25T10:00:00Z"),
      },
      { threshold: 0.82 },
    );

    expect(res.isNewStory).toBe(true);
    expect(res.storyId).toBe("new-story-id");
  });

  it("склеивает похожие материалы en и ru в один сюжет при схожести >= 0.82", async () => {
    const existingStory = {
      id: "existing-story-id",
      centroid: [0.99, 0.01],
      item_count: 1,
      source_diversity: 1,
      first_seen_at: new Date("2026-08-25T08:00:00Z"),
      last_seen_at: new Date("2026-08-25T08:00:00Z"),
      peak_external_signal: 10,
      similarity: 0.95, // > 0.82
    };

    let updatedStoryValues: any = null;

    const mockDb: any = {
      selectFrom: vi.fn((table: string) => {
        if (table === "stories") {
          return {
            select: vi.fn(() => ({
              where: vi.fn(() => ({
                where: vi.fn(() => ({
                  orderBy: vi.fn(() => ({
                    limit: vi.fn(() => ({
                      executeTakeFirst: vi.fn(async () => existingStory),
                    })),
                  })),
                })),
              })),
            })),
          };
        }
        if (table === "items") {
          return {
            select: vi.fn(() => ({
              distinct: vi.fn(() => ({
                where: vi.fn(() => ({
                  execute: vi.fn(async () => [{ source_id: "src-en" }]),
                })),
              })),
            })),
          };
        }
        return {};
      }),
      updateTable: vi.fn((table: string) => ({
        set: vi.fn((vals) => {
          if (table === "stories") updatedStoryValues = vals;
          return {
            where: vi.fn(() => ({
              execute: vi.fn(async () => []),
            })),
          };
        }),
      })),
    };

    const res = await clusterItemIntoStory(
      mockDb,
      {
        id: "item-ru",
        sourceId: "src-ru",
        embedding: [0.98, 0.02],
        discoveredAt: new Date("2026-08-25T10:00:00Z"),
        externalSignal: 50,
      },
      { threshold: 0.82 },
    );

    expect(res.isNewStory).toBe(false);
    expect(res.storyId).toBe("existing-story-id");
    expect(updatedStoryValues.item_count).toBe(2);
    expect(updatedStoryValues.source_diversity).toBe(2);
    expect(updatedStoryValues.peak_external_signal).toBe(50);
  });
});
