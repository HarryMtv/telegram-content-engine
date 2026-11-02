import type { Kysely } from "kysely";
import type { Database } from "../db/types.js";
import type { EmbeddingProvider } from "../embeddings/types.js";
import { vectorToString } from "../embeddings/service.js";

export function computeCentroid(vectors: number[][]): number[] {
  if (vectors.length === 0) return [];
  const dim = vectors[0]!.length;
  const sum = new Array<number>(dim).fill(0);

  for (const vec of vectors) {
    for (let i = 0; i < dim; i++) {
      sum[i] = (sum[i] ?? 0) + (vec[i] ?? 0);
    }
  }

  const mean = sum.map((val) => val / vectors.length);
  const norm = Math.sqrt(mean.reduce((acc, v) => acc + v * v, 0));
  if (norm === 0) return mean;
  return mean.map((v) => v / norm);
}

export async function recomputeProfileVector(
  db: Kysely<Database>,
  channelId: string,
  profileVersion: number,
  provider: EmbeddingProvider,
): Promise<{ vector: number[]; source: "published_posts" | "manifesto" }> {
  // 1. Пытаемся получить эмбеддинги одобренных и опубликованных материалов
  const publishedItems = await db
    .selectFrom("posts")
    .innerJoin("drafts", "drafts.id", "posts.draft_id")
    .innerJoin("channel_candidates", "channel_candidates.id", "drafts.candidate_id")
    .select(["channel_candidates.story_id"])
    .where("posts.channel_id", "=", channelId)
    .where("posts.published_at", "is not", null)
    .limit(50)
    .execute();

  const storyIds = publishedItems.map((p) => p.story_id).filter(Boolean) as string[];

  let vectors: number[][] = [];
  if (storyIds.length >= 3) {
    const stories = await db
      .selectFrom("stories")
      .select(["centroid"])
      .where("id", "in", storyIds)
      .where("centroid", "is not", null)
      .execute();

    vectors = stories
      .map((s) => {
        if (!s.centroid) return null;
        if (Array.isArray(s.centroid)) return s.centroid as number[];
        try {
          return JSON.parse(String(s.centroid));
        } catch {
          return null;
        }
      })
      .filter((v): v is number[] => Array.isArray(v) && v.length > 0);
  }

  let source: "published_posts" | "manifesto" = "published_posts";
  let centroid: number[];

  if (vectors.length >= 3) {
    centroid = computeCentroid(vectors);
  } else {
    // 2. Фолбэк: если постов < 3, строим эмбеддинг из манифеста + правил профиля
    const profile = await db
      .selectFrom("channel_profiles")
      .select(["manifesto", "selection_rules", "style_guide"])
      .where("channel_id", "=", channelId)
      .where("version", "=", profileVersion)
      .executeTakeFirst();

    const manifestText = [
      profile?.manifesto ?? "",
      profile?.selection_rules ?? "",
      profile?.style_guide ?? "",
    ]
      .filter(Boolean)
      .join("\n\n");

    const fallbackText = manifestText.trim().length > 10 ? manifestText : "Технологический канал";
    const [embedded] = await provider.embed([fallbackText]);
    centroid = embedded ?? new Array(1024).fill(0);
    source = "manifesto";
  }

  const vectorStr = vectorToString(centroid);

  await db
    .updateTable("channel_profiles")
    .set({
      profile_vector: vectorStr as never,
    })
    .where("channel_id", "=", channelId)
    .where("version", "=", profileVersion)
    .execute();

  return { vector: centroid, source };
}
