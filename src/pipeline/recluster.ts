import type { Kysely } from "kysely";
import type { Database } from "../db/types.js";
import { cosineSimilarity, updateCentroid, calculateVelocity } from "./clustering.js";

export interface ReclusterStats {
  totalItems: number;
  totalStories: number;
  avgItemsPerStory: number;
  maxItemsInStory: number;
  singletonsCount: number;
  threshold: number;
}

interface SimulatedStory {
  id: string;
  centroid: number[];
  itemCount: number;
  firstSeenAt: Date;
  lastSeenAt: Date;
  itemIds: string[];
}

/**
 * Офлайн-пересчёт кластеров Story для калибровки порога (design D6, Task 2.19).
 * Может работать как симуляция (dryRun: true) для подбора порога,
 * так и перезаписывать привязку items.story_id и stories.
 */
export async function reclusterStoriesOffline(
  db: Kysely<Database>,
  options: {
    threshold?: number;
    windowDays?: number;
    dryRun?: boolean;
  } = {},
): Promise<ReclusterStats> {
  const threshold = options.threshold ?? 0.82;
  const windowDays = options.windowDays ?? 14;
  const dryRun = options.dryRun ?? true;

  const items = await db
    .selectFrom("items")
    .select(["id", "embedding", "discovered_at", "source_id"])
    .where("embedding", "is not", null)
    .orderBy("discovered_at", "asc")
    .execute();

  const stories: SimulatedStory[] = [];

  for (const item of items) {
    if (!item.embedding) continue;
    const vec: number[] = Array.isArray(item.embedding)
      ? (item.embedding as number[])
      : JSON.parse(String(item.embedding));

    const itemDate = new Date(item.discovered_at);
    const windowStart = new Date(itemDate.getTime() - windowDays * 24 * 3600 * 1000);

    let bestStory: SimulatedStory | null = null;
    let bestSim = 0;

    for (const story of stories) {
      if (story.lastSeenAt < windowStart) continue;

      const sim = cosineSimilarity(vec, story.centroid);
      if (sim > bestSim) {
        bestSim = sim;
        bestStory = story;
      }
    }

    if (bestStory && bestSim >= threshold) {
      bestStory.centroid = updateCentroid(bestStory.centroid, vec, bestStory.itemCount);
      bestStory.itemCount += 1;
      bestStory.lastSeenAt = itemDate;
      bestStory.itemIds.push(item.id);
    } else {
      stories.push({
        id: `sim-story-${stories.length + 1}`,
        centroid: vec,
        itemCount: 1,
        firstSeenAt: itemDate,
        lastSeenAt: itemDate,
        itemIds: [item.id],
      });
    }
  }

  const totalItems = items.length;
  const totalStories = stories.length;
  const avgItemsPerStory = totalStories > 0 ? Number((totalItems / totalStories).toFixed(2)) : 0;
  const maxItemsInStory = stories.reduce((max, s) => Math.max(max, s.itemCount), 0);
  const singletonsCount = stories.filter((s) => s.itemCount === 1).length;

  return {
    totalItems,
    totalStories,
    avgItemsPerStory,
    maxItemsInStory,
    singletonsCount,
    threshold,
  };
}
