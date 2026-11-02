import { Pool } from 'pg';
import { Kysely, PostgresDialect } from 'kysely';
import type { Database } from './types.js';

export interface DbHandles {
  pool: Pool;
  db: Kysely<Database>;
}

/**
 * Доменное подключение: pooler в transaction mode, пул ≤5 на процесс (спека §3.3).
 * Хостам Supabase включаем TLS. Каждый процесс создаёт пул один раз.
 */
export function createDb(databaseUrl: string, max = 5): DbHandles {
  const isSupabase = /supabase\.(com|co)$/i.test(new URL(databaseUrl).hostname);
  const pool = new Pool({
    connectionString: databaseUrl,
    max,
    // pooler рвёт простаивающие соединения: keepalive + ранний retire
    keepAlive: true,
    keepAliveInitialDelayMillis: 10_000,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 15_000,
    ...(isSupabase ? { ssl: { rejectUnauthorized: false } } : {}),
  });
  // без обработчика смерть idle-клиента роняет процесс (unhandled 'error')
  pool.on('error', (err) => {
    console.error('[db pool] соединение умерло, пул восстановит его:', err.message);
  });
  const db = new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
  return { pool, db };
}

export async function closeDb(handles: DbHandles): Promise<void> {
  // db.destroy() закрывает и переданный в диалект пул
  await handles.db.destroy();
}
