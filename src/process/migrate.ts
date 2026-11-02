import { Pool } from 'pg';
import { runMigrations, defaultMigrationsDir } from '../db/migrate.js';

/**
 * Применение миграций db/migrations/*.sql.
 * Требует DATABASE_URL (pooler): pg-boss v10 и транзакции миграций
 * работают через transaction pooler; прямые хосты Supabase — только IPv6.
 */
async function main(): Promise<void> {
  const url = process.env.DATABASE_URL ?? process.env.DATABASE_URL_DIRECT;
  if (!url) throw new Error('Нужен env DATABASE_URL');
  const isSupabase = /supabase\.(com|co)$/i.test(new URL(url).hostname);
  const pool = new Pool({
    connectionString: url,
    max: 2,
    ...(isSupabase ? { ssl: { rejectUnauthorized: false } } : {}),
  });
  try {
    const applied = await runMigrations(pool, defaultMigrationsDir());
    console.log(applied.length ? `Применены миграции: ${applied.join(', ')}` : 'Миграций нет — схема актуальна');
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
