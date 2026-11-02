import { sql } from "kysely";
import type { Kysely } from "kysely";
import type { Database } from "../db/types.js";

export interface PostFormatConfig {
  id: string;
  channelId: string;
  slug: string;
  lane: "fast" | "slow";
  promptTemplate: string;
  targetLength: number;
  freshnessHalfLifeHours: number;
  cadence: Record<string, unknown>;
  dailyCap: number;
}

export type NotificationRoute = "immediate_breaking" | "scheduled_batch" | "cap_reached";

/**
 * Проверка лимита (daily_cap) опубликованных постов за сегодня (UTC).
 */
export async function getTodayPostCount(
  db: Kysely<Database>,
  channelId: string,
  now = new Date(),
): Promise<number> {
  const result = await db
    .selectFrom("posts")
    .select(sql<string>`count(*)`.as("cnt"))
    .where("channel_id", "=", channelId)
    .where("published_at", ">=", sql<Date>`date_trunc('day', ${now.toISOString()}::timestamptz)`)
    .executeTakeFirst();

  return Number(result?.cnt ?? 0);
}

/**
 * Маршрутизация кандидата по lane формата (fast/slow) и проверка суточного капа (Task 2.11).
 */
export function routeCandidateByFormat(
  candidate: { priority?: "normal" | "high"; isBreaking?: boolean },
  format: PostFormatConfig,
  currentDayPostsCount: number,
): { route: NotificationRoute; allowed: boolean; reason?: string } {
  if (currentDayPostsCount >= format.dailyCap) {
    return {
      route: "cap_reached",
      allowed: false,
      reason: `Суточный лимит постов (${format.dailyCap}) исчерпан (${currentDayPostsCount})`,
    };
  }

  if (format.lane === "fast" || candidate.priority === "high" || candidate.isBreaking) {
    return {
      route: "immediate_breaking",
      allowed: true,
      reason: "Срочный материал (fast lane / breaking) — точечное уведомление владельцу",
    };
  }

  return {
    route: "scheduled_batch",
    allowed: true,
    reason: "Стандартный материал (slow lane) — в плановый дневной батч",
  };
}
