import type { Kysely, Insertable } from 'kysely';
import { sql } from 'kysely';
import type { Database } from '../types.js';
import type { RawItem } from '../../domain/schemas.js';
import { vectorToString } from '../../embeddings/service.js';
import { clusterItemIntoStory, maxExternalSignal } from '../../pipeline/clustering.js';

export { CLUSTER_SIMILARITY_THRESHOLD } from '../../pipeline/clustering.js';

/** Пачка для одного bulk-запроса (спека §3.3: 100–500 строк). */
const CHUNK_SIZE = 500;

type ItemInsert = Insertable<Database['items']>;

type NormalizedInput = Omit<RawItem, 'fetchStatus' | 'bodyText' | 'contentHash'> & {
  bodyText?: string;
  contentHash?: string;
  fetchStatus: RawItem['fetchStatus'];
};

function toRow(raw: NormalizedInput): ItemInsert {
  return {
    source_id: raw.sourceId,
    external_id: raw.externalId,
    canonical_url: raw.canonicalUrl,
    url_hash: raw.urlHash,
    content_hash: raw.contentHash ?? null,
    title: raw.title,
    body_text: raw.bodyText ?? '',
    lang: raw.lang,
    author: raw.author ?? null,
    published_at: raw.publishedAt,
    discovered_at: raw.discoveredAt,
    external_signals: raw.externalSignals ?? null,
    fetch_status: raw.fetchStatus,
  };
}

/**
 * Вставка пачкой с дедупом на уровне БД: ON CONFLICT DO NOTHING покрывает
 * (source_id, external_id), url_hash и content_hash. Идемпотентна при ретрае джобы.
 */
export async function insertItemsIgnoreDuplicates(
  db: Kysely<Database>,
  raws: NormalizedInput[],
): Promise<number> {
  let inserted = 0;
  for (let i = 0; i < raws.length; i += CHUNK_SIZE) {
    const chunk = raws.slice(i, i + CHUNK_SIZE).map(toRow);
    const rows = await db
      .insertInto('items')
      .values(chunk)
      .onConflict((oc) => oc.doNothing())
      .returning('id')
      .execute();
    inserted += rows.length;
  }
  return inserted;
}

/** id ещё не обработанных pending-записей по списку url_hash — для постановки fetch. */
export async function selectPendingIds(
  db: Kysely<Database>,
  urlHashes: string[],
): Promise<{ id: string; canonical_url: string; title: string; external_id: string }[]> {
  if (urlHashes.length === 0) return [];
  const rows: { id: string; canonical_url: string; title: string; external_id: string }[] = [];
  for (let i = 0; i < urlHashes.length; i += CHUNK_SIZE) {
    const chunk = await db
      .selectFrom('items')
      .select(['id', 'canonical_url', 'title', 'external_id'])
      .where('url_hash', 'in', urlHashes.slice(i, i + CHUNK_SIZE))
      .where('fetch_status', '=', 'pending')
      .execute();
    rows.push(...chunk);
  }
  return rows;
}

/** Полное обновление после fetch; story создаётся при первом полном тексте. */
export async function completeItem(
  db: Kysely<Database>,
  itemId: string,
  raw: RawItem,
  embedding?: number[] | null,
): Promise<'updated' | 'discarded_duplicate'> {
  return db.transaction().execute(async (trx) => {
    const existing = await trx
      .selectFrom('items')
      .select(['id'])
      .where('content_hash', '=', raw.contentHash ?? '')
      .where('id', '!=', itemId)
      .executeTakeFirst();
    if (existing) {
      // точный дубль текста: запись отбрасывается, дубль уже представлен (спека §6.2 слой 1)
      await trx.deleteFrom('items').where('id', '=', itemId).execute();
      return 'discarded_duplicate';
    }

    const item = await trx
      .selectFrom('items')
      .select(['story_id'])
      .where('id', '=', itemId)
      .executeTakeFirst();
    if (!item) return 'discarded_duplicate';

    let storyId = item.story_id;

    if (!storyId) {
      if (embedding) {
        // Инкрементальная кластеризация в Story — единственная реализация (design D6):
        // окно 14 дней, бегущий центроид, обновление velocity / last_seen_at /
        // source_diversity / peak_external_signal, от которых зависит importance (§7).
        const clustered = await clusterItemIntoStory(trx, {
          id: itemId,
          sourceId: raw.sourceId,
          embedding,
          discoveredAt: raw.discoveredAt,
          externalSignal: maxExternalSignal(raw.externalSignals),
        });
        storyId = clustered.storyId;
      } else {
        // Без эмбеддинга склеивать не по чему — заводим story без центроида
        const story = await trx
          .insertInto('stories')
          .values({
            centroid: null,
            first_seen_at: raw.discoveredAt,
            last_seen_at: raw.discoveredAt,
            item_count: 1,
            source_diversity: 1,
            velocity: 1,
          })
          .returning('id')
          .executeTakeFirstOrThrow();
        storyId = story.id;
      }
    }

    await trx
      .updateTable('items')
      .set({
        body_text: raw.bodyText,
        lang: raw.lang,
        author: raw.author ?? null,
        content_hash: raw.contentHash ?? null,
        canonical_url: raw.canonicalUrl,
        fetch_status: 'ok',
        story_id: storyId,
        ...(embedding ? { embedding: sql<string>`${vectorToString(embedding)}::vector` as never } : {}),
      })
      .where('id', '=', itemId)
      .execute();

    return 'updated';
  });
}

/** Срочная метка о невозможности достать текст (шаг 3 лесенки — M2 уведомит владельца). */
export async function markItemFailed(
  db: Kysely<Database>,
  itemId: string,
  status: 'failed' | 'manual_needed',
): Promise<void> {
  await db.updateTable('items').set({ fetch_status: status }).where('id', '=', itemId).execute();
}

export async function countItems(db: Kysely<Database>): Promise<number> {
  const { count } = await db
    .selectFrom('items')
    .select((eb) => eb.fn.countAll<string>().as('count'))
    .executeTakeFirstOrThrow();
  return Number(count ?? '0');
}
