import { createHash } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Kysely, PostgresDialect } from 'kysely';
import { runMigrations, defaultMigrationsDir } from '../../src/db/migrate.js';
import { insertItemsIgnoreDuplicates, selectPendingIds, completeItem } from '../../src/db/repo/items.js';
import { normalizeRef, normalizeFetched } from '../../src/pipeline/normalize.js';
import type { Database } from '../../src/db/types.js';

const DB_URL = process.env.TEST_DATABASE_URL ?? '';
const d = describe.skipIf(!DB_URL);

let pool: Pool;
let db: Kysely<Database>;

const SOURCE_ID = '00000000-0000-0000-0000-0000000000aa';

/** Запись дешёвой фазы: pending, без content_hash — как из poll-source. */
function pendingRow(externalId: string, url: string) {
  return normalizeRef(
    { externalId, url, title: `Title ${externalId}`, publishedAt: new Date() },
    SOURCE_ID,
  );
}

/** Полный материал дорогой фазы — как из fetch-item. */
function fetchedRaw(externalId: string, url: string) {
  return normalizeFetched(
    {
      sourceId: SOURCE_ID,
      externalId,
      canonicalUrl: url,
      title: `Title ${externalId}`,
      publishedAt: new Date(),
      discoveredAt: new Date(),
    },
    `Body text for ${externalId} long enough for language detection.`,
  );
}

function sha(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

beforeAll(async () => {
  pool = new Pool({ connectionString: DB_URL, max: 5 });
  db = new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
  await runMigrations(pool, defaultMigrationsDir());
  // детерминизм между прогонами: чистим доменные таблицы (pgboss-схему не трогаем)
  await pool.query(
    'TRUNCATE items, stories, channel_candidates, fact_sheets, drafts, editorial_decisions, posts, submissions, sources, source_stats CASCADE',
  );
  await pool.query(
    `INSERT INTO sources (id, type, adapter, config) VALUES ($1, 'rss', 'rss', '{"key":"test"}')
     ON CONFLICT DO NOTHING`,
    [SOURCE_ID],
  );
});

afterAll(async () => {
  // db.destroy() закрывает и пул, переданный в диалект — второго end не нужно
  await db.destroy();
});

d('миграции (задача 1.2)', () => {
  it('повторное применение — no-op, таблица items существует', async () => {
    const applied = await runMigrations(pool, defaultMigrationsDir());
    expect(applied).toEqual([]);
    const { rows } = await pool.query(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'items'`,
    );
    expect(rows).toHaveLength(1);
  });

  it('уникальные индексы дедупа существуют', async () => {
    const { rows } = await pool.query(
      `SELECT indexname FROM pg_indexes WHERE tablename = 'items' AND indexname LIKE '%uidx%'`,
    );
    const names = rows.map((r) => r.indexname);
    expect(names).toContain('items_url_hash_uidx');
    expect(names).toContain('items_content_hash_uidx');
  });
});

d('вставка пачкой с дедупом (задача 1.6)', () => {
  it('повторная вставка той же пачки не создаёт дублей', async () => {
    const batch = [pendingRow('e1', 'https://example.com/1'), pendingRow('e2', 'https://example.com/2')];
    const first = await insertItemsIgnoreDuplicates(db, batch);
    const second = await insertItemsIgnoreDuplicates(db, batch);
    expect(first).toBe(2);
    expect(second).toBe(0);
  });

  it('тот же материал под другой ссылкой отбрасывается по url_hash', async () => {
    const inserted = await insertItemsIgnoreDuplicates(db, [
      pendingRow('e3', 'https://example.com/1?utm_source=rss'),
    ]);
    expect(inserted).toBe(0);
  });

  it('selectPendingIds отдаёт вставленные pending-записи', async () => {
    const pending = await selectPendingIds(db, [sha('https://example.com/1'), sha('https://example.com/2')]);
    expect(pending.map((p) => p.external_id).sort()).toEqual(['e1', 'e2']);
  });
});

d('completeItem: дедуп контента и создание Story (спека §6.2-6.3)', () => {
  it('создаёт story и помечает ok', async () => {
    const pending = await selectPendingIds(db, [sha('https://example.com/2')]);
    const target = pending.find((p) => p.external_id === 'e2')!;
    const result = await completeItem(db, target.id, fetchedRaw('e2', 'https://example.com/2'));
    expect(result).toBe('updated');

    const { rows } = await pool.query('SELECT story_id, fetch_status FROM items WHERE id = $1', [target.id]);
    expect(rows[0].fetch_status).toBe('ok');
    expect(rows[0].story_id).toBeTruthy();

    const stories = await pool.query('SELECT item_count FROM stories WHERE id = $1', [rows[0].story_id]);
    expect(Number(stories.rows[0].item_count)).toBe(1);
  });

  it('точный дубль текста отбрасывается на дорогой фазе', async () => {
    // e4 приходит как отдельная ссылка (pending), но текст совпадает с e2
    const inserted = await insertItemsIgnoreDuplicates(db, [pendingRow('e4', 'https://example.com/2-dup')]);
    expect(inserted).toBe(1);

    const pending = await selectPendingIds(db, [sha('https://example.com/2-dup')]);
    const target = pending.find((p) => p.external_id === 'e4')!;
    const dupRaw = fetchedRaw('e2', 'https://example.com/2'); // тот же content_hash, что у e2
    const result = await completeItem(db, target.id, dupRaw);
    expect(result).toBe('discarded_duplicate');

    const { rows } = await pool.query('SELECT count(*)::int AS n FROM items WHERE external_id = $1', ['e4']);
    expect(rows[0].n).toBe(0);
  });
});
