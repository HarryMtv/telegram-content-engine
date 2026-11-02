import { z } from 'zod';
import type { Kysely } from 'kysely';
import type { Database } from '../../db/types.js';
import { canonicalizeUrl, urlHash } from '../../pipeline/canonicalize-url.js';
import { processIngest } from '../../ingest/service.js';
import type { SearchProvider, SearchResultItem } from '../../search/index.js';

// 1. search_sources Tool
export const SearchSourcesInput = z.object({
  query: z.string().min(1),
  limit: z.number().int().min(1).max(50).default(10),
});
export type SearchSourcesInput = z.infer<typeof SearchSourcesInput>;

export interface SourceSearchResult {
  id: string;
  title: string;
  canonicalUrl: string;
  bodySnippet: string;
  publishedAt: Date | null;
}

export async function searchSources(
  db: Kysely<Database>,
  input: SearchSourcesInput,
): Promise<SourceSearchResult[]> {
  const q = `%${input.query.toLowerCase()}%`;
  const rows = await db
    .selectFrom('items')
    .select(['id', 'title', 'canonical_url', 'body_text', 'published_at'])
    .where((eb) =>
      eb.or([
        eb('title', 'ilike', q),
        eb('body_text', 'ilike', q),
        eb('canonical_url', 'ilike', q),
      ]),
    )
    .orderBy('discovered_at', 'desc')
    .limit(input.limit)
    .execute();

  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    canonicalUrl: r.canonical_url,
    bodySnippet: (r.body_text || '').slice(0, 300),
    publishedAt: r.published_at ? new Date(r.published_at) : null,
  }));
}

// 2. check_duplicate Tool
export const CheckDuplicateInput = z.object({
  url: z.string().url().optional(),
  title: z.string().optional(),
});
export type CheckDuplicateInput = z.infer<typeof CheckDuplicateInput>;

export interface CheckDuplicateResult {
  isDuplicate: boolean;
  reason?: string | undefined;
  matchedId?: string | undefined;
  matchedTitle?: string | undefined;
}

export async function checkDuplicate(
  db: Kysely<Database>,
  input: CheckDuplicateInput,
): Promise<CheckDuplicateResult> {
  if (input.url) {
    try {
      const canonical = canonicalizeUrl(input.url);
      const hash = urlHash(canonical);

      const existingItem = await db
        .selectFrom('items')
        .select(['id', 'title'])
        .where('url_hash', '=', hash)
        .executeTakeFirst();

      if (existingItem) {
        return {
          isDuplicate: true,
          reason: 'Найден существующий материал с идентичным URL',
          matchedId: existingItem.id,
          matchedTitle: existingItem.title,
        };
      }
    } catch {
      // невалидный формат URL, пропускаем проверку URL
    }
  }

  if (input.title) {
    const q = input.title.trim().toLowerCase();
    if (q.length >= 10) {
      const match = await db
        .selectFrom('items')
        .select(['id', 'title'])
        .where('title', 'ilike', `%${q}%`)
        .limit(1)
        .executeTakeFirst();

      if (match) {
        return {
          isDuplicate: true,
          reason: 'Найден материал с похожим заголовком',
          matchedId: match.id,
          matchedTitle: match.title,
        };
      }
    }
  }

  return { isDuplicate: false };
}

// 3. get_published_history Tool
export const GetPublishedHistoryInput = z.object({
  limit: z.number().int().min(1).max(50).default(20),
  days: z.number().int().min(1).max(90).default(14),
});
export type GetPublishedHistoryInput = z.infer<typeof GetPublishedHistoryInput>;

export interface PublishedPostHistory {
  postId: string;
  finalText: string;
  publishedAt: Date;
  views: number | null;
  forwards: number | null;
  err: number | null;
  decisionAction?: string | undefined;
  rejectionReason?: string | undefined;
}

export async function getPublishedHistory(
  db: Kysely<Database>,
  input: GetPublishedHistoryInput,
): Promise<PublishedPostHistory[]> {
  const cutoff = new Date(Date.now() - input.days * 24 * 3600 * 1000);

  const posts = await db
    .selectFrom('posts')
    .leftJoin('metric_snapshots', (join) =>
      join
        .onRef('metric_snapshots.post_id', '=', 'posts.id')
        .on('metric_snapshots.offset_hours', '=', 24),
    )
    .select([
      'posts.id as post_id',
      'posts.final_text',
      'posts.published_at',
      'metric_snapshots.views',
      'metric_snapshots.forwards',
      'metric_snapshots.err',
    ])
    .where('posts.published_at', '>=', cutoff)
    .orderBy('posts.published_at', 'desc')
    .limit(input.limit)
    .execute();

  return posts.map((p) => ({
    postId: p.post_id,
    finalText: p.final_text,
    publishedAt: new Date(p.published_at),
    views: p.views,
    forwards: p.forwards,
    err: p.err !== null ? Number(p.err) : null,
  }));
}

// 4. get_channel_profile Tool
export const GetChannelProfileInput = z.object({
  channelId: z.string().uuid().optional(),
});
export type GetChannelProfileInput = z.infer<typeof GetChannelProfileInput>;

export interface ChannelProfileData {
  channelId: string;
  version: number;
  selectionRules: string[];
  taboos: string[];
  styleGuide: string;
  weights: Record<string, number>;
}

export async function getChannelProfile(
  db: Kysely<Database>,
  input: GetChannelProfileInput,
): Promise<ChannelProfileData | null> {
  let query = db
    .selectFrom('channel_profiles')
    .selectAll()
    .orderBy('version', 'desc')
    .limit(1);

  if (input.channelId) {
    query = query.where('channel_id', '=', input.channelId);
  }

  const profile = await query.executeTakeFirst();
  if (!profile) return null;

  const selectionRules = typeof profile.selection_rules === 'string'
    ? profile.selection_rules.split('\n').filter(Boolean)
    : ((profile.selection_rules as unknown as string[]) ?? []);

  return {
    channelId: profile.channel_id,
    version: profile.version,
    selectionRules,
    taboos: (profile.taboos as string[]) ?? [],
    styleGuide: profile.style_guide ?? '',
    weights: (profile.score_weights as Record<string, number>) ?? {},
  };
}

// 5. submit_item Tool
export const SubmitItemInput = z.object({
  url: z.string().url(),
  title: z.string().min(1),
  rawText: z.string().optional(),
  priority: z.enum(['normal', 'high']).default('normal'),
});
export type SubmitItemInput = z.infer<typeof SubmitItemInput>;

export interface SubmitItemResult {
  accepted: boolean;
  submissionId?: string | undefined;
  itemId?: string | undefined;
  message: string;
}

export async function submitItem(
  db: Kysely<Database>,
  input: SubmitItemInput,
): Promise<SubmitItemResult> {
  const res = await processIngest(db, {
    urls: [input.url],
    text: input.rawText ?? input.title,
    submittedBy: 0,
    role: 'owner',
    priority: input.priority,
  });

  const firstResult = res.results[0];
  if (!firstResult) {
    return {
      accepted: false,
      message: res.feedbackText || 'Не удалось обработать материал',
    };
  }

  if (firstResult.status.startsWith('duplicate')) {
    return {
      accepted: false,
      message: firstResult.message || 'Дубликат: материал уже существует',
      itemId: firstResult.itemId,
    };
  }

  if (firstResult.status === 'rejected') {
    return {
      accepted: false,
      message: firstResult.message || 'Материал отклонён при ингесте',
    };
  }

  return {
    accepted: true,
    itemId: firstResult.itemId,
    message: firstResult.message || 'Успешно отправлено в конвейер обработки',
  };
}

// 7. web_search Tool
export const WebSearchInput = z.object({
  query: z.string().min(1),
  limit: z.number().int().min(1).max(20).default(5),
});
export type WebSearchInput = z.infer<typeof WebSearchInput>;

export async function webSearch(
  provider: SearchProvider,
  input: WebSearchInput,
): Promise<SearchResultItem[]> {
  return provider.search(input.query, input.limit);
}

