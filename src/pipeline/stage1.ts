import type { Kysely } from "kysely";
import { sql } from "kysely";
import type { Database } from "../db/types.js";
import { cosineSimilarity, maxExternalSignal } from "./clustering.js";

/**
 * Стадия 1 — числовые скоры без LLM (спека §6.4, M2).
 * Компоненты: relevance (к profile_vector), source_trust, freshness, importance.
 */

export interface Stage1Weights {
  trust: number;
  freshness: number;
  relevance: number;
  importance: number;
}

export const DEFAULT_STAGE1_WEIGHTS: Stage1Weights = {
  relevance: 0.35,
  importance: 0.25,
  freshness: 0.20,
  trust: 0.20,
};

export function parseStage1Weights(raw: unknown): Stage1Weights {
  if (raw && typeof raw === "object") {
    const w = raw as Record<string, unknown>;
    const trust = typeof w.trust === "number" ? w.trust : DEFAULT_STAGE1_WEIGHTS.trust;
    const freshness = typeof w.freshness === "number" ? w.freshness : DEFAULT_STAGE1_WEIGHTS.freshness;
    const relevance = typeof w.relevance === "number" ? w.relevance : DEFAULT_STAGE1_WEIGHTS.relevance;
    const importance = typeof w.importance === "number" ? w.importance : DEFAULT_STAGE1_WEIGHTS.importance;
    return { trust, freshness, relevance, importance };
  }
  return DEFAULT_STAGE1_WEIGHTS;
}

// Алиас для обратной совместимости с M1
export const parseWeights = parseStage1Weights;
export const DEFAULT_WEIGHTS = { trust: 0.5, freshness: 0.5 };

/** Экспоненциальное затухание свежести: 1 → 0.5 за полураспад (спека §6.5). */
export function freshnessScore(publishedAt: Date, halfLifeHours: number, now = new Date()): number {
  const ageHours = Math.max(0, (now.getTime() - publishedAt.getTime()) / 3_600_000);
  return Number(Math.pow(0.5, ageHours / Math.max(1, halfLifeHours)).toFixed(4));
}

/**
 * Расчёт важности (importance) как функции метрик сюжета и внешних сигналов.
 */
export function calculateImportance(metrics: {
  itemCount?: number;
  sourceDiversity?: number;
  velocity?: number;
  externalSignal?: number;
}): number {
  const count = metrics.itemCount ?? 1;
  const div = metrics.sourceDiversity ?? 1;
  const vel = metrics.velocity ?? 0;
  const sig = metrics.externalSignal ?? 0;

  const storyScore = Math.min(1.0, 0.2 * Math.max(0, count - 1) + 0.3 * Math.max(0, div - 1) + 0.1 * Math.min(5, vel));
  const signalScore = Math.min(1.0, Math.log10(1 + Math.max(0, sig)) / 3);

  return Number(Math.min(1.0, 0.6 * storyScore + 0.4 * signalScore).toFixed(4));
}

export interface Stage1Item {
  itemId: string;
  storyId: string;
  trustScore: number;
  publishedAt: Date;
  embedding?: number[] | null;
  itemCount?: number;
  sourceDiversity?: number;
  velocity?: number;
  externalSignals?: Record<string, number | string> | null;
}

/**
 * Множитель скора для наводок, у которых Resolver не нашёл первоисточник
 * (спека §5.3: «candidates are retained with `no_primary_source` and a score penalty»).
 * Кандидат остаётся в пуле, но проигрывает материалу с честной атрибуцией (§10.3).
 */
export const NO_PRIMARY_SOURCE_PENALTY = 0.7;

export interface ScoredCandidate extends Stage1Item {
  scoreTotal: number;
  components: {
    trust: number;
    freshness: number;
    relevance: number;
    importance: number;
    /** Применённый множитель §5.3: 1 — штрафа нет. */
    primarySourcePenalty: number;
  };
}

export function scoreBatch(
  items: Stage1Item[],
  halfLifeHours: number,
  weights: Stage1Weights,
  options?: {
    profileVector?: number[] | null;
    now?: Date;
  },
): ScoredCandidate[] {
  const now = options?.now ?? new Date();
  const profileVector = options?.profileVector;

  return items
    .map((item) => {
      const trust = clamp01(item.trustScore);
      const freshness = freshnessScore(item.publishedAt, halfLifeHours, now);

      let relevance = 0.5;
      if (profileVector && item.embedding && item.embedding.length === profileVector.length) {
        relevance = clamp01(cosineSimilarity(item.embedding, profileVector));
      }

      // Максимальный числовой внешний сигнал (HN очки, Reddit karma, GitHub stars)
      const maxSignal = maxExternalSignal(item.externalSignals);

      const importance = calculateImportance({
        itemCount: item.itemCount ?? 1,
        sourceDiversity: item.sourceDiversity ?? 1,
        velocity: item.velocity ?? 0,
        externalSignal: maxSignal,
      });

      // §5.3: наводка без найденного первоисточника остаётся в пуле, но со штрафом
      const primarySourcePenalty = item.externalSignals?.no_primary_source
        ? NO_PRIMARY_SOURCE_PENALTY
        : 1;

      const scoreTotal = Number(
        (
          (weights.relevance * relevance +
            weights.importance * importance +
            weights.freshness * freshness +
            weights.trust * trust) *
          primarySourcePenalty
        ).toFixed(4),
      );

      return {
        ...item,
        components: { trust, freshness, relevance, importance, primarySourcePenalty },
        scoreTotal,
      };
    })
    .sort((a, b) => b.scoreTotal - a.scoreTotal);
}

function clamp01(x: number): number {
  return Math.min(1, Math.max(0, x));
}

/** Материалы, готовые к скорингу: fetch ok, есть story, без живого кандидата. */
export async function selectScorableItems(
  db: Kysely<Database>,
  maxAgeHours: number,
  limit = 100,
): Promise<Stage1Item[]> {
  const rows = await db
    .selectFrom("items")
    .innerJoin("sources", "sources.id", "items.source_id")
    .leftJoin("stories", "stories.id", "items.story_id")
    .select([
      "items.id as itemId",
      "items.story_id as storyId",
      "sources.trust_score as trustScore",
      "items.published_at as publishedAt",
      "items.embedding as embedding",
      "items.external_signals as externalSignals",
      "stories.item_count as itemCount",
      "stories.source_diversity as sourceDiversity",
      "stories.velocity as velocity",
    ])
    .where("items.fetch_status", "=", "ok")
    .where("items.story_id", "is not", null)
    .where(sql<boolean>`items.published_at > now() - (${maxAgeHours} || ' hours')::interval`)
    .where((eb) =>
      eb.not((eb) =>
        eb.exists(
          eb
            .selectFrom("channel_candidates")
            .select("id")
            .whereRef("channel_candidates.story_id", "=", "items.story_id"),
        ),
      ),
    )
    .orderBy("items.published_at", "desc")
    .limit(limit)
    .execute();

  return rows.map((r) => ({
    itemId: r.itemId,
    storyId: r.storyId!,
    trustScore: Number(r.trustScore),
    publishedAt: r.publishedAt!,
    embedding: r.embedding
      ? Array.isArray(r.embedding)
        ? (r.embedding as number[])
        : JSON.parse(String(r.embedding))
      : null,
    itemCount: r.itemCount ?? 1,
    sourceDiversity: r.sourceDiversity ?? 1,
    velocity: r.velocity ? Number(r.velocity) : 0,
    externalSignals: r.externalSignals as Record<string, number | string> | null,
  }));
}
