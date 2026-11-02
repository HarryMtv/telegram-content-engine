import { sql } from "kysely";
import type { Kysely } from "kysely";
import type { Database } from "../db/types.js";
import type { EmbeddingProvider } from "./types.js";

export function formatItemForEmbedding(title: string, bodyText: string): string {
  const snippet = bodyText.trim().slice(0, 1500);
  return `${title}\n\n${snippet}`.trim();
}

export function vectorToString(vec: number[]): string {
  return `[${vec.join(",")}]`;
}

/**
 * Пакетная векторизация материалов без эмбеддингов.
 * Идемпотентна: повторный вызов не дублирует и обновляет только items без embedding.
 */
export async function embedPendingItems(
  db: Kysely<Database>,
  provider: EmbeddingProvider,
  batchSize: number = 20,
): Promise<{ processed: number; itemIds: string[] }> {
  const pending = await db
    .selectFrom("items")
    .select(["id", "title", "body_text"])
    .where("fetch_status", "=", "ok")
    .where("embedding", "is", null)
    .orderBy("published_at", "desc")
    .limit(batchSize)
    .execute();

  if (pending.length === 0) {
    return { processed: 0, itemIds: [] };
  }

  const texts = pending.map((item) => formatItemForEmbedding(item.title, item.body_text));
  const embeddings = await provider.embed(texts);

  const itemIds: string[] = [];
  for (let i = 0; i < pending.length; i++) {
    const item = pending[i]!;
    const vec = embeddings[i]!;
    const vecStr = vectorToString(vec);

    await db
      .updateTable("items")
      .set({
        embedding: sql<string>`${vecStr}::vector`,
      })
      .where("id", "=", item.id)
      .execute();

    itemIds.push(item.id);
  }

  return { processed: itemIds.length, itemIds };
}
