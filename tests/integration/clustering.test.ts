import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Kysely, PostgresDialect } from 'kysely';
import { runMigrations, defaultMigrationsDir } from '../../src/db/migrate.js';
import { insertItemsIgnoreDuplicates, completeItem, CLUSTER_SIMILARITY_THRESHOLD } from '../../src/db/repo/items.js';
import { normalizeRef, normalizeFetched } from '../../src/pipeline/normalize.js';
import { cosineSimilarity } from '../../src/pipeline/clustering.js';
import type { Database } from '../../src/db/types.js';

const DB_URL = process.env.TEST_DATABASE_URL ?? '';
const d = describe.skipIf(!DB_URL);

let pool: Pool;
let db: Kysely<Database>;

const SOURCE_ID = '00000000-0000-0000-0000-0000000000bb';
const DIM = 1024;

/**
 * Кластеризация M2 (спека §6.3, design D6): материалы с близкими эмбеддингами
 * склеиваются в одну story (порог 0.82 к центроиду), непохожие — отдельные.
 * Реальный провайдер не нужен: в completeItem вектор передаётся готовым.
 */

/** Унитарный вектор с ненулевой компонентой i. */
function unitVector(i: number, value = 1): number[] {
  const vec = new Array<number>(DIM).fill(0);
  vec[i] = value;
  return vec;
}

/** Нормированный вектор-смесь: близок к e0, ортогонален e1. */
function mixedVector(): number[] {
  const raw = [0.99, 0.14, ...new Array<number>(DIM - 2).fill(0)];
  const norm = Math.sqrt(raw.reduce((s, v) => s + v * v, 0));
  return raw.map((v) => v / norm);
}

async function insertPending(externalId: string, url: string, title: string): Promise<string> {
  const refs = [normalizeRef({ externalId, url, title, publishedAt: new Date() }, SOURCE_ID)];
  await insertItemsIgnoreDuplicates(db, refs);
  const row = await db
    .selectFrom('items')
    .select('id')
    .where('external_id', '=', externalId)
    .executeTakeFirstOrThrow();
  return row.id;
}

function rawFor(externalId: string, url: string, title: string) {
  return normalizeFetched(
    {
      sourceId: SOURCE_ID,
      externalId,
      canonicalUrl: url,
      title,
      publishedAt: new Date(),
      discoveredAt: new Date(),
    },
    `Body text for ${externalId}: достаточно длинный текст для языка и хэшей.`,
  );
}

beforeAll(async () => {
  pool = new Pool({ connectionString: DB_URL, max: 5 });
  db = new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
  await runMigrations(pool, defaultMigrationsDir());
  await pool.query(
    'TRUNCATE items, stories, channel_candidates, fact_sheets, drafts, editorial_decisions, posts, submissions, sources, source_stats CASCADE',
  );
  await pool.query(
    `INSERT INTO sources (id, type, adapter, config) VALUES ($1, 'rss', 'rss', '{"key":"cluster-test"}')
     ON CONFLICT DO NOTHING`,
    [SOURCE_ID],
  );
});

afterAll(async () => {
  await pool.end();
});

d('Кластеризация по эмбеддингам (порог 0.82)', () => {
  const vecA = unitVector(0); // e0
  const vecB = mixedVector(); // близок к e0: косинус ≈ 0.99
  const vecC = unitVector(1); // e1, ортогонален e0

  it('тестовые векторы согласованы с порогом', () => {
    expect(cosineSimilarity(vecA, vecB)).toBeGreaterThanOrEqual(CLUSTER_SIMILARITY_THRESHOLD);
    expect(cosineSimilarity(vecA, vecC)).toBeLessThan(CLUSTER_SIMILARITY_THRESHOLD);
  });

  it('первый материал создаёт story со своим центроидом', async () => {
    const idA = await insertPending('cl-a', 'https://example.com/a', 'Story A');
    const res = await completeItem(db, idA, rawFor('cl-a', 'https://example.com/a', 'Story A'), vecA);
    expect(res).toBe('updated');

    const item = await db
      .selectFrom('items')
      .select(['story_id', 'embedding'])
      .where('id', '=', idA)
      .executeTakeFirstOrThrow();
    expect(item.story_id).not.toBeNull();
    expect(item.embedding).not.toBeNull();

    const story = await db
      .selectFrom('stories')
      .select(['id', 'item_count', 'centroid'])
      .where('id', '=', item.story_id!)
      .executeTakeFirstOrThrow();
    expect(story.item_count).toBe(1);
    expect(story.centroid).not.toBeNull();
    // центроид новой story — сам вектор: близость к vecA ≈ 1
    const centroid = String(story.centroid)
      .replace(/^\[|\]$/g, '')
      .split(',')
      .map(Number);
    expect(cosineSimilarity(centroid, vecA)).toBeGreaterThan(0.999);
  });

  it('похожий материал приклеивается к той же story, центроид сдвигается', async () => {
    const idB = await insertPending('cl-b', 'https://example.com/b', 'Story B');
    await completeItem(db, idB, rawFor('cl-b', 'https://example.com/b', 'Story B'), vecB);

    const itemB = await db
      .selectFrom('items')
      .select(['story_id'])
      .where('id', '=', idB)
      .executeTakeFirstOrThrow();

    const itemA = await db
      .selectFrom('items')
      .select(['story_id'])
      .where('external_id', '=', 'cl-a')
      .executeTakeFirstOrThrow();
    expect(itemB.story_id).toBe(itemA.story_id);

    const story = await db
      .selectFrom('stories')
      .select(['item_count', 'centroid'])
      .where('id', '=', itemB.story_id!)
      .executeTakeFirstOrThrow();
    expect(story.item_count).toBe(2);

    // центроид — нормированное среднее vecA и vecB: близок к обоим, но не равен ни одному
    const centroid = String(story.centroid)
      .replace(/^\[|\]$/g, '')
      .split(',')
      .map(Number);
    expect(cosineSimilarity(centroid, vecA)).toBeGreaterThan(0.99);
    expect(cosineSimilarity(centroid, vecB)).toBeGreaterThan(0.99);
  });

  it('непохожий материал уходит в отдельную story', async () => {
    const idC = await insertPending('cl-c', 'https://example.com/c', 'Story C');
    await completeItem(db, idC, rawFor('cl-c', 'https://example.com/c', 'Story C'), vecC);

    const itemC = await db
      .selectFrom('items')
      .select(['story_id'])
      .where('id', '=', idC)
      .executeTakeFirstOrThrow();
    const itemA = await db
      .selectFrom('items')
      .select(['story_id'])
      .where('external_id', '=', 'cl-a')
      .executeTakeFirstOrThrow();

    expect(itemC.story_id).not.toBe(itemA.story_id);

    const storyC = await db
      .selectFrom('stories')
      .select('item_count')
      .where('id', '=', itemC.story_id!)
      .executeTakeFirstOrThrow();
    expect(storyC.item_count).toBe(1);
  });

  it('материал без вектора сохраняет старое поведение: своя story без центроида', async () => {
    const idD = await insertPending('cl-d', 'https://example.com/d', 'Story D');
    await completeItem(db, idD, rawFor('cl-d', 'https://example.com/d', 'Story D'));

    const itemD = await db
      .selectFrom('items')
      .select(['story_id', 'embedding'])
      .where('id', '=', idD)
      .executeTakeFirstOrThrow();
    expect(itemD.story_id).not.toBeNull();
    expect(itemD.embedding).toBeNull();

    const storyD = await db
      .selectFrom('stories')
      .select('centroid')
      .where('id', '=', itemD.story_id!)
      .executeTakeFirstOrThrow();
    expect(storyD.centroid).toBeNull();
  });

  it('склейка обновляет динамику story: last_seen_at, velocity, peak_external_signal (design D6, §4.3)', async () => {
    const vecE = unitVector(5);

    const idE = await insertPending('cl-e', 'https://example.com/e', 'Story E');
    await completeItem(db, idE, rawFor('cl-e', 'https://example.com/e', 'Story E'), vecE);
    const itemE = await db
      .selectFrom('items')
      .select('story_id')
      .where('id', '=', idE)
      .executeTakeFirstOrThrow();

    const before = await db
      .selectFrom('stories')
      .select(['last_seen_at', 'velocity', 'peak_external_signal'])
      .where('id', '=', itemE.story_id!)
      .executeTakeFirstOrThrow();

    const idF = await insertPending('cl-f', 'https://example.com/f', 'Story F');
    await completeItem(
      db,
      idF,
      {
        ...rawFor('cl-f', 'https://example.com/f', 'Story F'),
        discoveredAt: new Date(Date.now() + 3600 * 1000),
        externalSignals: { hn_points: 120 },
      },
      vecE,
    );

    const itemF = await db
      .selectFrom('items')
      .select('story_id')
      .where('id', '=', idF)
      .executeTakeFirstOrThrow();
    expect(itemF.story_id).toBe(itemE.story_id);

    const after = await db
      .selectFrom('stories')
      .select(['last_seen_at', 'velocity', 'peak_external_signal'])
      .where('id', '=', itemE.story_id!)
      .executeTakeFirstOrThrow();

    // Именно из этих полей §7 считает importance — без них скоринг читает протухшие данные
    expect(new Date(after.last_seen_at).getTime()).toBeGreaterThan(new Date(before.last_seen_at).getTime());
    expect(Number(after.velocity)).toBeGreaterThan(Number(before.velocity));
    expect(Number(after.peak_external_signal)).toBe(120);
  });

  it('story вне окна 14 дней не переиспользуется (design D6)', async () => {
    const vecG = unitVector(7);

    const idG = await insertPending('cl-g', 'https://example.com/g', 'Story G');
    await completeItem(db, idG, rawFor('cl-g', 'https://example.com/g', 'Story G'), vecG);
    const itemG = await db
      .selectFrom('items')
      .select('story_id')
      .where('id', '=', idG)
      .executeTakeFirstOrThrow();

    // «Состариваем» сюжет: последний материал в нём — 30 дней назад
    await db
      .updateTable('stories')
      .set({ last_seen_at: new Date(Date.now() - 30 * 24 * 3600 * 1000) })
      .where('id', '=', itemG.story_id!)
      .execute();

    const idH = await insertPending('cl-h', 'https://example.com/h', 'Story H');
    await completeItem(db, idH, rawFor('cl-h', 'https://example.com/h', 'Story H'), vecG);
    const itemH = await db
      .selectFrom('items')
      .select('story_id')
      .where('id', '=', idH)
      .executeTakeFirstOrThrow();

    // Тот же вектор, но сюжет протух — склейки быть не должно
    expect(itemH.story_id).not.toBe(itemG.story_id);
  });
});
