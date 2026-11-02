import { describe, expect, it, vi } from "vitest";
import { computeCentroid, recomputeProfileVector } from "../../src/pipeline/profile-vector.js";
import { MockEmbeddingProvider } from "../../src/embeddings/mock.js";

describe("Channel profile_vector recomputation (Task 2.4)", () => {
  it("рассчитывает усреднённый L2 нормализованный центроид для массива векторов", () => {
    const v1 = [1, 0, 0];
    const v2 = [0, 1, 0];
    const v3 = [0, 0, 1];
    const centroid = computeCentroid([v1, v2, v3]);

    expect(centroid.length).toBe(3);
    expect(centroid[0]).toBeCloseTo(0.57735, 4);
    expect(centroid[1]).toBeCloseTo(0.57735, 4);
    expect(centroid[2]).toBeCloseTo(0.57735, 4);

    const norm = Math.sqrt(centroid.reduce((acc, v) => acc + v * v, 0));
    expect(norm).toBeCloseTo(1.0, 4);
  });

  it("пересчитывает profile_vector из манифеста, если опубликованных постов < 3", async () => {
    let updatedProfileVector: string | null = null;

    const createPostsQueryMock = () => {
      const q: any = {};
      q.innerJoin = vi.fn(() => q);
      q.select = vi.fn(() => q);
      q.where = vi.fn(() => q);
      q.limit = vi.fn(() => q);
      q.execute = vi.fn(async () => []); // 0 постов
      return q;
    };

    const mockDb: any = {
      selectFrom: vi.fn((table: string) => {
        if (table === "posts") {
          return createPostsQueryMock();
        }
        if (table === "channel_profiles") {
          return {
            select: vi.fn(() => ({
              where: vi.fn(() => ({
                where: vi.fn(() => ({
                  executeTakeFirst: vi.fn(async () => ({
                    manifesto: "Канал об AI и машинном обучении",
                    selection_rules: "Берём важные научные статьи и релизы",
                    style_guide: "Без воды, чёткие факты",
                  })),
                })),
              })),
            })),
          };
        }
        return {};
      }),
      updateTable: vi.fn(() => ({
        set: vi.fn((vals) => {
          updatedProfileVector = vals.profile_vector;
          return {
            where: vi.fn(() => ({
              where: vi.fn(() => ({
                execute: vi.fn(async () => []),
              })),
            })),
          };
        }),
      })),
    };

    const provider = new MockEmbeddingProvider();
    const result = await recomputeProfileVector(mockDb, "channel-1", 1, provider);

    expect(result.source).toBe("manifesto");
    expect(result.vector.length).toBe(1024);
    expect(updatedProfileVector).toBeDefined();
  });

  it("пересчитывает profile_vector как центроид по опубликованным материалам при наличии >= 3", async () => {
    const v1 = new Array(1024).fill(0.1);
    const v2 = new Array(1024).fill(0.2);
    const v3 = new Array(1024).fill(0.3);

    const createPostsQueryMock = () => {
      const q: any = {};
      q.innerJoin = vi.fn(() => q);
      q.select = vi.fn(() => q);
      q.where = vi.fn(() => q);
      q.limit = vi.fn(() => q);
      q.execute = vi.fn(async () => [
        { story_id: "s1" },
        { story_id: "s2" },
        { story_id: "s3" },
      ]);
      return q;
    };

    const mockDb: any = {
      selectFrom: vi.fn((table: string) => {
        if (table === "posts") {
          return createPostsQueryMock();
        }
        if (table === "stories") {
          return {
            select: vi.fn(() => ({
              where: vi.fn(() => ({
                where: vi.fn(() => ({
                  execute: vi.fn(async () => [
                    { centroid: v1 },
                    { centroid: v2 },
                    { centroid: v3 },
                  ]),
                })),
              })),
            })),
          };
        }
        return {};
      }),
      updateTable: vi.fn(() => ({
        set: vi.fn(() => ({
          where: vi.fn(() => ({
            where: vi.fn(() => ({
              execute: vi.fn(async () => []),
            })),
          })),
        })),
      })),
    };

    const provider = new MockEmbeddingProvider();
    const result = await recomputeProfileVector(mockDb, "channel-1", 1, provider);

    expect(result.source).toBe("published_posts");
    expect(result.vector.length).toBe(1024);
    // mock provider не вызывался, так как использованы посты
    expect(provider.callCount).toBe(0);
  });
});
