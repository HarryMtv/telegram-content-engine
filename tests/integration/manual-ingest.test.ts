import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Kysely, PostgresDialect } from 'kysely';
import { runMigrations, defaultMigrationsDir } from '../../src/db/migrate.js';
import { processIngest } from '../../src/ingest/service.js';
import { selectScorableItems, scoreBatch, parseStage1Weights } from '../../src/pipeline/stage1.js';
import type { Database } from '../../src/db/types.js';

const DB_URL = process.env.TEST_DATABASE_URL ?? '';
const d = describe.skipIf(!DB_URL);

let pool: Pool;
let db: Kysely<Database>;

const OWNER_ID = 471600732;

/**
 * Ручной ингест M3: пересылки и текст без ссылки.
 * Регрессия: текстовые/пересланные материалы создавались со story_id = null,
 * а selectScorableItems берёт только items со story — пересылки навсегда
 * выпадали из конвейера и никогда не доходили до черновика.
 */
beforeAll(async () => {
  pool = new Pool({ connectionString: DB_URL, max: 5 });
  db = new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
  await runMigrations(pool, defaultMigrationsDir());
  await pool.query(
    'TRUNCATE items, stories, channel_candidates, fact_sheets, drafts, editorial_decisions, posts, submissions, sources, source_stats CASCADE',
  );
});

afterAll(async () => {
  await pool.end();
});

d('Ручной ингест: пересылки и текст без ссылки', () => {
  it('пересланный пост создаёт item со story и fetch_status=ok', async () => {
    const res = await processIngest(db, {
      submittedBy: OWNER_ID,
      role: 'owner',
      text: 'Релиз нового фреймворка для инференса на устройствах. Подробности в блоге компании.',
      isForward: true,
      forwardFromTitle: 'Тестовый канал',
    });

    expect(res.success).toBe(true);
    expect(res.acceptedCount).toBe(1);
    expect(res.results[0]!.message).toContain('принят');

    const item = await db
      .selectFrom('items')
      .select(['id', 'fetch_status', 'story_id', 'author'])
      .where('id', '=', res.results[0]!.itemId!)
      .executeTakeFirstOrThrow();

    expect(item.fetch_status).toBe('ok');
    expect(item.story_id).not.toBeNull();
    expect(item.author).toBe('Тестовый канал');
  });

  it('пересланный материал попадает в скоринг батча (регрессия story_id)', async () => {
    const item = await db
      .selectFrom('items')
      .select(['id', 'story_id'])
      .where('canonical_url', 'like', 'https://t.me/submission/%')
      .orderBy('discovered_at', 'desc')
      .limit(1)
      .executeTakeFirstOrThrow();

    // Ровно тот фильтр, что раньше отсекал пересылки: story_id is not null
    const scorable = await selectScorableItems(db, 480, 100);
    expect(scorable.some((s) => s.itemId === item.id)).toBe(true);

    // Единственный материал в чистой базе — верх скоринга, кандидат на триаж
    const scored = scoreBatch(scorable, 120, parseStage1Weights(undefined), { profileVector: null });
    expect(scored.length).toBeGreaterThan(0);
    expect(scored[0]!.storyId).toBe(item.story_id);
  });

  it('повторная пересылка того же текста не создаёт дубль', async () => {
    const text = 'Уникальный текст для проверки дедупликации пересылок.';
    const first = await processIngest(db, {
      submittedBy: OWNER_ID,
      role: 'owner',
      text,
      isForward: true,
      forwardFromTitle: 'Канал А',
    });
    const second = await processIngest(db, {
      submittedBy: OWNER_ID,
      role: 'owner',
      text,
      isForward: true,
      forwardFromTitle: 'Канал А',
    });

    expect(first.results[0]!.itemId).toBeDefined();
    expect(second.results[0]!.itemId).toBe(first.results[0]!.itemId);

    const rows = await db
      .selectFrom('items')
      .select('id')
      .where('id', '=', first.results[0]!.itemId!)
      .execute();
    expect(rows).toHaveLength(1);
  });

  it('URL-материал по-прежнему идёт в fetch: pending и без story', async () => {
    const res = await processIngest(db, {
      submittedBy: OWNER_ID,
      role: 'owner',
      text: 'https://example.com/some-article',
    });

    expect(res.success).toBe(true);
    const item = await db
      .selectFrom('items')
      .select(['fetch_status', 'story_id'])
      .where('id', '=', res.results[0]!.itemId!)
      .executeTakeFirstOrThrow();

    // Story для URL появляется позже, в completeItem на fetch-стадии
    expect(item.fetch_status).toBe('pending');
    expect(item.story_id).toBeNull();
  });
});
