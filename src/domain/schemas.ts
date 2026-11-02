import { z } from 'zod';

/**
 * Служебные флаги в items.external_signals: их пишет Resolver (спека §5.3),
 * и они НЕ являются прокси виральности из §15. Скоринг и кластеризация обязаны
 * исключать их при поиске максимального внешнего сигнала, иначе `no_primary_source: 1`
 * сам себе накручивает importance.
 */
export const PRIMARY_SOURCE_FLAGS = ['no_primary_source', 'resolved_primary_source'] as const;

/** Дешёвая ссылка из discover-фазы адаптера: без полного текста. */
export const ItemRef = z.object({
  externalId: z.string().min(1),
  url: z.string().url(),
  title: z.string().min(1),
  publishedAt: z.coerce.date(),
  snippet: z.string().max(2000).optional(),
  /** Сигналы вовлечённости источника: {hn_points, reddit_upvotes, gh_stars_delta…} */
  externalSignals: z.record(z.union([z.number(), z.string()])).optional(),
});
export type ItemRef = z.infer<typeof ItemRef>;

/** Полный материал после fetch-фазы, приведённый к единому виду (спека §6.1). */
export const RawItem = z.object({
  sourceId: z.string().uuid(),
  externalId: z.string().min(1),
  canonicalUrl: z.string().url(),
  urlHash: z.string().length(64),
  contentHash: z.string().length(64).optional(),
  title: z.string().min(1),
  bodyText: z.string().default(''),
  lang: z.string().min(2).max(3),
  author: z.string().optional(),
  publishedAt: z.coerce.date(),
  discoveredAt: z.coerce.date().default(() => new Date()),
  externalSignals: z.record(z.union([z.number(), z.string()])).optional(),
  rawPayload: z.record(z.unknown()).optional(),
  fetchStatus: z.enum(['pending', 'ok', 'failed', 'manual_needed']).default('ok'),
});
export type RawItem = z.infer<typeof RawItem>;

/** config источника из таблицы sources (поле config jsonb). */
export const SourceConfig = z
  .object({
    /** стабильный ключ для идемпотентного сида/ON CONFLICT */
    key: z.string().min(1),
    url: z.string().url().optional(),
    /** порог отбора (очки HN, апвоуты и т.п.) */
    threshold: z.coerce.number().optional(),
    subreddit: z.string().optional(),
    query: z.string().optional(),
    /** домены-исключения для конкретного источника */
    excludeDomains: z.array(z.string()).optional(),
  })
  .passthrough();
export type SourceConfig = z.infer<typeof SourceConfig>;

export const SourceStatus = z.enum(['healthy', 'degraded', 'dead']);
export type SourceStatus = z.infer<typeof SourceStatus>;

/** Строка таблицы sources, с которой работает конвейер. */
export interface SourceRow {
  id: string;
  type: string;
  adapter: string;
  config: SourceConfig;
  pollIntervalS: number;
  cursor: Record<string, unknown> | null;
  trustScore: number;
  status: SourceStatus;
  errorCount: number;
  lastOkAt: Date | null;
  lastError: string | null;
}
