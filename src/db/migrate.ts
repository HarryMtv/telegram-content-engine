import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { Pool } from 'pg';

/**
 * Раннер SQL-миграций: db/migrations/NNN_*.sql по порядку, каждая в транзакции,
 * применённое фиксируется в _migrations. Идемпотентен: повторный запуск — no-op.
 * Запускается из корня репозитория (npm run migrate) или из Docker-образа.
 */
export async function runMigrations(pool: Pool, migrationsDir = defaultMigrationsDir()): Promise<string[]> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS _migrations (
      name     text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  const { rows } = await pool.query<{ name: string }>('SELECT name FROM _migrations');
  const applied = new Set(rows.map((r) => r.name));

  const files = (await readdir(migrationsDir)).filter((f) => /^\d{3,}_.*\.sql$/.test(f)).sort();
  const newlyApplied: string[] = [];
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = await readFile(path.join(migrationsDir, file), 'utf8');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO _migrations (name) VALUES ($1)', [file]);
      await client.query('COMMIT');
      newlyApplied.push(file);
    } catch (err) {
      await client.query('ROLLBACK');
      throw new Error(`Миграция ${file} не применилась: ${String(err)}`);
    } finally {
      client.release();
    }
  }
  return newlyApplied;
}

export function defaultMigrationsDir(): string {
  return path.resolve(process.cwd(), 'db', 'migrations');
}
