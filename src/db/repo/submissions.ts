import type { Kysely } from 'kysely';
import type { Database } from '../types.js';

export interface CreateSubmissionInput {
  submittedBy: bigint | number;
  role: 'owner' | 'contributor';
  payloadType: 'url' | 'forward' | 'text' | 'file';
  raw: string;
  channelHint?: string | null | undefined;
  priority?: 'normal' | 'high' | undefined;
  status?: 'received' | 'duplicate' | 'rejected' | 'ingested' | 'published' | undefined;
  itemId?: string | null | undefined;
}

export async function createSubmission(
  db: Kysely<Database>,
  input: CreateSubmissionInput,
): Promise<{ id: string }> {
  const row = await db
    .insertInto('submissions')
    .values({
      submitted_by: BigInt(input.submittedBy) as never,
      role: input.role,
      payload_type: input.payloadType,
      raw: input.raw,
      channel_hint: input.channelHint ?? null,
      priority: input.priority ?? 'normal',
      status: input.status ?? 'received',
      item_id: input.itemId ?? null,
      feedback_sent: false,
    })
    .returning('id')
    .executeTakeFirstOrThrow();

  return { id: row.id };
}

export async function getOrCreateContributor(
  db: Kysely<Database>,
  tgUserId: bigint | number,
): Promise<{ tgUserId: bigint; submissionsTotal: number; submissionsPublished: number; reputation: number; banned: boolean }> {
  const userId = BigInt(tgUserId);
  const existing = await db
    .selectFrom('contributors')
    .selectAll()
    .where('tg_user_id', '=', userId as never)
    .executeTakeFirst();

  if (existing) {
    return {
      tgUserId: BigInt(existing.tg_user_id as string | number | bigint),
      submissionsTotal: existing.submissions_total,
      submissionsPublished: existing.submissions_published,
      reputation: Number(existing.reputation ?? 1.0),
      banned: Boolean(existing.banned),
    };
  }

  await db
    .insertInto('contributors')
    .values({
      tg_user_id: userId as never,
      submissions_total: 0,
      submissions_published: 0,
      reputation: 1.0 as never,
      banned: false,
    })
    .onConflict((oc) => oc.doNothing())
    .execute();

  return {
    tgUserId: userId,
    submissionsTotal: 0,
    submissionsPublished: 0,
    reputation: 1.0,
    banned: false,
  };
}

export async function checkContributorRateLimit(
  db: Kysely<Database>,
  tgUserId: bigint | number,
  maxDaily = 10,
): Promise<{ allowed: boolean; reason?: 'banned' | 'rate_limit_exceeded'; currentCount: number }> {
  const contributor = await getOrCreateContributor(db, tgUserId);
  if (contributor.banned) {
    return { allowed: false, reason: 'banned', currentCount: 0 };
  }

  const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const countRes = await db
    .selectFrom('submissions')
    .select((eb) => eb.fn.countAll<string>().as('count'))
    .where('submitted_by', '=', BigInt(tgUserId) as never)
    .where('created_at', '>=', oneDayAgo)
    .executeTakeFirst();

  const currentCount = Number(countRes?.count ?? 0);
  if (currentCount >= maxDaily) {
    return { allowed: false, reason: 'rate_limit_exceeded', currentCount };
  }

  return { allowed: true, currentCount };
}

export async function incrementContributorStats(
  db: Kysely<Database>,
  tgUserId: bigint | number,
  published = false,
): Promise<void> {
  const userId = BigInt(tgUserId);
  if (published) {
    await db
      .updateTable('contributors')
      .set((eb) => ({
        submissions_total: eb('submissions_total', '+', 1),
        submissions_published: eb('submissions_published', '+', 1),
      }))
      .where('tg_user_id', '=', userId as never)
      .execute();
  } else {
    await db
      .updateTable('contributors')
      .set((eb) => ({
        submissions_total: eb('submissions_total', '+', 1),
      }))
      .where('tg_user_id', '=', userId as never)
      .execute();
  }
}

/**
 * Проверка: публиковался ли материал с таким url_hash ранее.
 */
export async function findRecentPublicationByUrlHash(
  db: Kysely<Database>,
  hash: string,
): Promise<{ itemId: string; title: string; publishedAt: Date | null } | null> {
  const row = await db
    .selectFrom('items')
    .leftJoin('posts', 'posts.draft_id', 'items.id')
    .select([
      'items.id as item_id',
      'items.title',
      'items.published_at',
      'items.discovered_at',
      'posts.published_at as post_published_at',
    ])
    .where('items.url_hash', '=', hash)
    .executeTakeFirst();

  if (!row) return null;

  return {
    itemId: row.item_id,
    title: row.title,
    publishedAt: (row.post_published_at ?? row.published_at ?? row.discovered_at) as Date | null,
  };
}

/**
 * Счётчик ручных материалов с определённого домена за последние N дней.
 * Спека §7.4: при 3-й ссылке на домен предлагается добавить RSS.
 */
export async function countRecentDomainSubmissions(
  db: Kysely<Database>,
  domain: string,
  days = 30,
): Promise<number> {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const pattern = `%://${domain}/%`;
  const patternWww = `%://www.${domain}/%`;

  const res = await db
    .selectFrom('submissions')
    .select((eb) => eb.fn.countAll<string>().as('count'))
    .where('created_at', '>=', since)
    .where((eb) =>
      eb.or([
        eb('raw', 'like', pattern),
        eb('raw', 'like', patternWww),
      ])
    )
    .executeTakeFirst();

  return Number(res?.count ?? 0);
}
