import { describe, expect, it, vi } from "vitest";
import { reclusterStoriesOffline } from "../../src/pipeline/recluster.js";

describe("Offline Story Reclustering (Task 2.19)", () => {
  it("пересчитывает статистику кластеризации для калибровки порога", async () => {
    const mockItems = [
      { id: "1", embedding: [1, 0, 0], discovered_at: new Date("2026-08-01T10:00:00Z"), source_id: "s1" },
      { id: "2", embedding: [0.95, 0.05, 0], discovered_at: new Date("2026-08-01T11:00:00Z"), source_id: "s2" }, // Похож на 1
      { id: "3", embedding: [0, 1, 0], discovered_at: new Date("2026-08-01T12:00:00Z"), source_id: "s1" }, // Другая тема
    ];

    const mockDb: any = {
      selectFrom: vi.fn(() => ({
        select: vi.fn(() => ({
          where: vi.fn(() => ({
            orderBy: vi.fn(() => ({
              execute: vi.fn(async () => mockItems),
            })),
          })),
        })),
      })),
    };

    const statsHighThreshold = await reclusterStoriesOffline(mockDb, { threshold: 0.82 });
    expect(statsHighThreshold.totalItems).toBe(3);
    // items 1 и 2 склеились в одну Story, item 3 — отдельная Story -> 2 Stories
    expect(statsHighThreshold.totalStories).toBe(2);
    expect(statsHighThreshold.maxItemsInStory).toBe(2);
    expect(statsHighThreshold.singletonsCount).toBe(1);
  });
});
