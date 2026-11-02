import { sql } from "kysely";
import type { Kysely } from "kysely";
import type { Database } from "../db/types.js";
import { vectorToString } from "../embeddings/service.js";
import { PRIMARY_SOURCE_FLAGS } from "../domain/schemas.js";

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    const ai = a[i]!;
    const bi = b[i]!;
    dot += ai * bi;
    normA += ai * ai;
    normB += bi * bi;
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  if (denom === 0) return 0;
  return Number((dot / denom).toFixed(6));
}

export function updateCentroid(
  currentCentroid: number[],
  newVector: number[],
  currentCount: number,
): number[] {
  const nextCount = currentCount + 1;
  const updated: number[] = new Array(currentCentroid.length);
  for (let i = 0; i < currentCentroid.length; i++) {
    updated[i] = (currentCentroid[i]! * currentCount + newVector[i]!) / nextCount;
  }
  // Нормализация L2
  const norm = Math.sqrt(updated.reduce((sum, v) => sum + v * v, 0)) || 1;
  return updated.map((v) => Number((v / norm).toFixed(6)));
}

export function calculateVelocity(
  itemCount: number,
  firstSeenAt: Date | string,
  lastSeenAt: Date | string,
): number {
  const t1 = new Date(firstSeenAt).getTime();
  const t2 = new Date(lastSeenAt).getTime();
  const hours = Math.max(0.5, (t2 - t1) / (1000 * 3600));
  return Number((itemCount / hours).toFixed(4));
}

/**
 * Порог семантической близости для склейки в одну story (спека §6.3, design D6):
 * косинусная близость эмбеддинга материала к центроиду ближайшей story.
 */
export const CLUSTER_SIMILARITY_THRESHOLD = 0.82;

/** Окно поиска ближайшего сюжета в днях (design D6). */
export const CLUSTER_WINDOW_DAYS = 14;

export interface ClusteringItemInput {
  id: string;
  sourceId: string;
  embedding: number[];
  discoveredAt: Date;
  externalSignal?: number;
}

export interface ClusteringOptions {
  threshold?: number;
  windowDays?: number;
}

/**
 * Максимальный числовой внешний сигнал материала (очки HN, karma, звёзды GitHub).
 * Служебные флаги Resolver'а сигналом не считаются — см. PRIMARY_SOURCE_FLAGS.
 */
export function maxExternalSignal(
  signals?: Record<string, number | string> | null,
): number {
  let max = 0;
  for (const [key, val] of Object.entries(signals ?? {})) {
    if (PRIMARY_SOURCE_FLAGS.includes(key as (typeof PRIMARY_SOURCE_FLAGS)[number])) continue;
    if (typeof val === "number" && !Number.isNaN(val)) max = Math.max(max, val);
  }
  return max;
}

/**
 * Инкрементальная кластеризация материала в Story (design D6).
 * Ищет ближайший сюжет в окне N дней через косинусную близость.
 */
export async function clusterItemIntoStory(
  db: Kysely<Database>,
  item: ClusteringItemInput,
  options: ClusteringOptions = {},
): Promise<{ storyId: string; isNewStory: boolean; similarity: number }> {
  const threshold = options.threshold ?? CLUSTER_SIMILARITY_THRESHOLD;
  const windowDays = options.windowDays ?? CLUSTER_WINDOW_DAYS;

  const windowStart = new Date(item.discoveredAt.getTime() - windowDays * 24 * 3600 * 1000);
  const vecStr = vectorToString(item.embedding);

  // Ищем ближайшую Story с центроидом через pgvector (<=> косинусное расстояние: 1 - cosine_sim)
  // В Kysely: 1 - (centroid <=> vec) = cosine_similarity
  const candidateStory = await db
    .selectFrom("stories")
    .select([
      "id",
      "centroid",
      "item_count",
      "source_diversity",
      "first_seen_at",
      "last_seen_at",
      "peak_external_signal",
      sql<number>`1 - (centroid <=> ${vecStr}::vector)`.as("similarity"),
    ])
    .where("last_seen_at", ">=", windowStart)
    .where("centroid", "is not", null)
    .orderBy(sql`centroid <=> ${vecStr}::vector`, "asc")
    .limit(1)
    .executeTakeFirst();

  const sim = candidateStory?.similarity ? Number(candidateStory.similarity) : 0;
  const signal = item.externalSignal ?? 0;

  if (candidateStory && sim >= threshold) {
    // Присоединяем к существующей Story
    const currentCentroid: number[] = Array.isArray(candidateStory.centroid)
      ? (candidateStory.centroid as number[])
      : JSON.parse(String(candidateStory.centroid));

    const updatedCentroid = updateCentroid(
      currentCentroid,
      item.embedding,
      candidateStory.item_count,
    );

    const nextItemCount = candidateStory.item_count + 1;
    const velocity = calculateVelocity(nextItemCount, candidateStory.first_seen_at, item.discoveredAt);
    const peakSignal = Math.max(Number(candidateStory.peak_external_signal || 0), signal);

    // Подсчёт уникальных источников в Story
    const existingSources = await db
      .selectFrom("items")
      .select("source_id")
      .distinct()
      .where("story_id", "=", candidateStory.id)
      .execute();
    const sourceSet = new Set(existingSources.map((s) => s.source_id));
    sourceSet.add(item.sourceId);

    await db
      .updateTable("stories")
      .set({
        centroid: sql<string>`${vectorToString(updatedCentroid)}::vector`,
        last_seen_at: item.discoveredAt,
        item_count: nextItemCount,
        source_diversity: sourceSet.size,
        velocity: velocity as never,
        peak_external_signal: peakSignal as never,
      })
      .where("id", "=", candidateStory.id)
      .execute();

    await db
      .updateTable("items")
      .set({ story_id: candidateStory.id })
      .where("id", "=", item.id)
      .execute();

    return { storyId: candidateStory.id, isNewStory: false, similarity: sim };
  }

  // Создаём новую Story
  const newStory = await db
    .insertInto("stories")
    .values({
      centroid: sql<string>`${vecStr}::vector`,
      first_seen_at: item.discoveredAt,
      last_seen_at: item.discoveredAt,
      item_count: 1,
      source_diversity: 1,
      velocity: 1,
      peak_external_signal: signal as never,
    })
    .returning("id")
    .executeTakeFirstOrThrow();

  await db
    .updateTable("items")
    .set({ story_id: newStory.id })
    .where("id", "=", item.id)
    .execute();

  return { storyId: newStory.id, isNewStory: true, similarity: 1.0 };
}
