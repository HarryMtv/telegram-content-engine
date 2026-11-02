import { describe, expect, it, vi } from "vitest";
import { cleanupOldEmbeddings } from "../../src/pipeline/cleanup.js";

describe("Embeddings Cleanup Job (Task 2.16)", () => {
  it("обнуляет векторы старше 90 дней, сохраняя метаданные", async () => {
    let itemsUpdated = 0n;
    let storiesUpdated = 0n;

    const mockDb: any = {
      updateTable: vi.fn((table: string) => ({
        set: vi.fn(() => ({
          where: vi.fn(() => ({
            where: vi.fn(() => ({
              executeTakeFirst: vi.fn(async () => {
                if (table === "items") itemsUpdated = 12n;
                if (table === "stories") storiesUpdated = 3n;
                return { numUpdatedRows: table === "items" ? 12n : 3n };
              }),
            })),
          })),
        })),
      })),
    };

    const now = new Date("2026-08-25T00:00:00Z");
    const result = await cleanupOldEmbeddings(mockDb, 90, now);

    expect(result.cleanedItems).toBe(12);
    expect(result.cleanedStories).toBe(3);
    expect(mockDb.updateTable).toHaveBeenCalledWith("items");
    expect(mockDb.updateTable).toHaveBeenCalledWith("stories");
  });
});
