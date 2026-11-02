import type { Kysely } from 'kysely';
import type { Database } from '../db/types.js';

export interface PostMetricData {
  postId: string;
  offsetHours: number;
  views?: number | null | undefined;
  forwards?: number | null | undefined;
  reactions?: Record<string, number> | null | undefined;
  subscribersAtPublish?: number | null | undefined;
}

export function calculateErr(
  views: number,
  subscribers: number,
  forwards = 0,
  reactions: Record<string, number> = {},
): number | null {
  if (subscribers <= 0) return null;
  const totalReactions = Object.values(reactions).reduce((sum, count) => sum + count, 0);
  const engagement = views + 2 * forwards + totalReactions;
  const err = (engagement / subscribers) * 100;
  return Math.round(err * 100) / 100;
}

export async function saveMetricSnapshot(
  db: Kysely<Database>,
  data: PostMetricData,
): Promise<{ id: string }> {
  const views = data.views ?? 0;
  const forwards = data.forwards ?? 0;
  const reactions = data.reactions ?? {};
  const subs = data.subscribersAtPublish ?? 0;

  const err = subs > 0 ? calculateErr(views, subs, forwards, reactions) : null;

  const inserted = await db
    .insertInto('metric_snapshots')
    .values({
      post_id: data.postId,
      offset_hours: data.offsetHours,
      views: data.views ?? null,
      forwards: data.forwards ?? null,
      reactions: reactions as never,
      err: err !== null ? (err as never) : null,
    })
    .returning('post_id')
    .executeTakeFirstOrThrow();

  return { id: inserted.post_id };
}

export async function getPostMetricHistory(
  db: Kysely<Database>,
  postId: string,
): Promise<Array<{ offsetHours: number; views: number | null; forwards: number | null; reactions: unknown; err: number | null }>> {
  const rows = await db
    .selectFrom('metric_snapshots')
    .select(['offset_hours', 'views', 'forwards', 'reactions', 'err'])
    .where('post_id', '=', postId)
    .orderBy('offset_hours', 'asc')
    .execute();

  return rows.map((r) => ({
    offsetHours: r.offset_hours,
    views: r.views,
    forwards: r.forwards,
    reactions: r.reactions,
    err: r.err !== null ? Number(r.err) : null,
  }));
}
