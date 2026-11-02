import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Kysely, PostgresDialect } from 'kysely';
import { runMigrations, defaultMigrationsDir } from '../../src/db/migrate.js';
import { selectDueSources, DEAD_RETRY_INTERVAL_S } from '../../src/db/repo/sources.js';
import type { Database } from '../../src/db/types.js';

const DB_URL = process.env.TEST_DATABASE_URL ?? '';
const d = describe.skipIf(!DB_URL);

let pool: Pool;
let db: Kysely<Database>;

beforeAll(async () => {
  pool = new Pool({ connectionString: DB_URL, max: 5 });
  db = new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
  await runMigrations(pool, defaultMigrationsDir());
  await pool.query('TRUNCATE items, sources, source_stats CASCADE');
  // poll_interval_s = 600 у всех: разницу даёт только время последней попытки
  // границы кулдауна берём от самой константы, чтобы тест не разъехался с ней
  const halfCooldown = DEAD_RETRY_INTERVAL_S / 2;
  const pastCooldown = DEAD_RETRY_INTERVAL_S + 3600;
  await pool.query(`
    INSERT INTO sources (type, adapter, config, poll_interval_s, status, last_ok_at, last_error_at) VALUES
      ('api', 'ok-fresh',      '{"key":"ok-fresh"}',      600, 'healthy',  now() - interval '5 seconds', NULL),
      ('api', 'never-polled',  '{"key":"never-polled"}',  600, 'healthy',  NULL,                         NULL),
      ('api', 'failed-recent', '{"key":"failed-recent"}', 600, 'degraded', now() - interval '2 hours',   now() - interval '30 seconds'),
      ('api', 'failed-stale',  '{"key":"failed-stale"}',  600, 'degraded', now() - interval '2 hours',   now() - interval '20 minutes'),
      ('api', 'dead-recent',   '{"key":"dead-recent"}',   600, 'dead',     now() - interval '2 days',    now() - make_interval(secs => ${halfCooldown})),
      ('api', 'dead-stale',    '{"key":"dead-stale"}',    600, 'dead',     now() - interval '2 days',    now() - make_interval(secs => ${pastCooldown}))
  `);
});

afterAll(async () => {
  await db.destroy();
});

d('выборка источников к опросу (спека §3.2)', () => {
  it('отбирает по времени последней попытки, dead — раз в 6 часов', async () => {
    const due = (await selectDueSources(db)).map((s) => s.adapter).sort();

    expect(due).toEqual(['dead-stale', 'failed-stale', 'never-polled']);
  });

  it('свежая неудача не делает источник просроченным на каждом тике', async () => {
    // регрессия: раньше интервал считался от last_ok_at, который при ошибке
    // не двигался — упавший источник попадал в выборку каждую минуту
    const due = (await selectDueSources(db)).map((s) => s.adapter);

    expect(due).not.toContain('failed-recent');
  });

  it('dead-источник возвращается в опрос после кулдауна и оживает при успехе', async () => {
    expect((await selectDueSources(db)).map((s) => s.adapter)).toContain('dead-stale');

    // успешный опрос: onSuccess() пишет healthy/0/last_ok_at
    await pool.query(
      `UPDATE sources SET status = 'healthy', error_count = 0, last_ok_at = now() WHERE adapter = 'dead-stale'`,
    );

    expect((await selectDueSources(db)).map((s) => s.adapter)).not.toContain('dead-stale');
  });
});
