import { sql } from "kysely";
import type { Kysely } from "kysely";
import type { Database } from "../db/types.js";

/**
 * Еженедельная очистка устаревших эмбеддингов (спека §4.3, Task 2.16).
 * Обнуляет векторы старше 90 дней для экономии места в pgvector, при этом
 * хэши (url_hash, content_hash) и метаданные материалов остаются.
 */
export async function cleanupOldEmbeddings(
  db: Kysely<Database>,
  maxAgeDays: number = 90,
  now = new Date(),
): Promise<{ cleanedItems: number; cleanedStories: number }> {
  const cutoffDate = new Date(now.getTime() - maxAgeDays * 24 * 3600 * 1000);

  // Очистка эмбеддингов items старше cutoffDate
  const itemsRes = await db
    .updateTable("items")
    .set({ embedding: null })
    .where("embedding", "is not", null)
    .where((eb) =>
      eb.or([
        eb("published_at", "<", cutoffDate),
        eb.and([eb("published_at", "is", null), eb("discovered_at", "<", cutoffDate)]),
      ]),
    )
    .executeTakeFirst();

  // Очистка центроидов stories старше cutoffDate
  const storiesRes = await db
    .updateTable("stories")
    .set({ centroid: null })
    .where("centroid", "is not", null)
    .where("last_seen_at", "<", cutoffDate)
    .executeTakeFirst();

  return {
    cleanedItems: Number(itemsRes.numUpdatedRows || 0n),
    cleanedStories: Number(storiesRes.numUpdatedRows || 0n),
  };
}
