import PgBoss from 'pg-boss';

/**
 * Имена и полезные нагрузки джоб. singleton-ключи держат идемпотентность (design D7):
 * один и тот же poll не исполняется параллельно самому себе.
 */
export const JobNames = {
  tick: 'tick',
  pollSource: 'poll-source',
  fetchItem: 'fetch-item',
  buildBatch: 'build-batch',
  sendBatch: 'send-batch',
} as const;

/** Очереди агентов M4 (§14.4): Resolver/Scout/Analyst — исполняет worker-agents. */
export const AgentJobNames = {
  runResolver: 'agent:resolver',
  runScout: 'agent:scout',
  runAnalyst: 'agent:analyst',
} as const;

export interface PollSourceJob {
  sourceId: string;
}
export interface FetchItemJob {
  itemId: string;
}
export interface BuildBatchJob {
  channelId: string;
}
export interface SendBatchJob {
  batchId: string;
  draftIds: string[];
}

/** Полезные нагрузки агентов M4 (zod-схемы в src/agents/*). */
export interface ResolverJob {
  itemId: string;
  text: string;
  channelTitle?: string;
}
export interface ScoutJob {
  topicHint?: string;
  maxCandidates?: number;
}
export interface AnalystJob {
  channelId?: string;
  days?: number;
}

/**
 * Очередь на pg-boss через pooler (см. design D3: v10 поллит, LISTEN/NOTIFY нет).
 * Опции уходят прямо в pg.Pool: keepalive и ранний retire idle-клиентов нужны,
 * потому что transaction pooler агрессивно рвёт простаивающие соединения.
 * Ошибки пула подписываются отдельно — без обработчика они валят процесс.
 */
export function createBoss(databaseUrl: string): PgBoss {
  const isSupabase = /supabase\.(com|co)$/i.test(new URL(databaseUrl).hostname);
  // опции уходят в pg.Pool как есть; в типах ConstructorOptions pg-ключей нет — каст
  const options = {
    connectionString: databaseUrl,
    max: 2,
    keepAlive: true,
    keepAliveInitialDelayMillis: 10_000,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 15_000,
    ...(isSupabase ? { ssl: { rejectUnauthorized: false } } : {}),
  } as ConstructorParameters<typeof PgBoss>[0];
  const boss = new PgBoss(options);
  boss.on('error', (err) => {
    // сетевые сбои (сон машины, смена сети, ресайкл pooler'а) не должны ронять процесс:
    // supervise/timekeeper повторят свой цикл на следующем тике
    console.error('[pg-boss] временная ошибка соединения:', err.message);
  });
  return boss;
}

/**
 * В pg-boss v10 send падает молча (null), если очередь не создана.
 * Создаём все очереди явно; createQueue идемпотентен (ON CONFLICT DO NOTHING).
 *
 * Гонка при старте: все процессы поднимаются разом (Coolify стартует сервисы
 * параллельно), и параллельные INSERT в pgboss.queue ловят deadlock (40P01).
 * createQueue идемпотентен, поэтому просто повторяем: как только очереди создал
 * хоть один процесс, у остальных конфликта нет. Джиттер разводит процессы,
 * чтобы не упереться в тот же дедлок снова.
 */
const QUEUE_CREATE_ATTEMPTS = 5;
const LOCK_RACE_CODES = new Set(['40P01', '40001', '40P03']);

export async function ensureQueues(boss: PgBoss): Promise<void> {
  const names = [...Object.values(JobNames), ...Object.values(AgentJobNames)];
  for (let attempt = 1; ; attempt++) {
    try {
      for (const name of names) {
        await boss.createQueue(name);
      }
      return;
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (!LOCK_RACE_CODES.has(code ?? '') || attempt >= QUEUE_CREATE_ATTEMPTS) throw err;
      const delayMs = 200 * 2 ** (attempt - 1) + Math.floor(Math.random() * 150);
      console.error(
        `[pg-boss] гонка создания очередей (pg ${code}), повтор ${attempt + 1}/${QUEUE_CREATE_ATTEMPTS} через ${delayMs}мс`,
      );
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

/**
 * Постановка Resolver'а для телеграм-наводки без первоисточника (спека §5.3).
 * Политика ретраев и singletonKey живут здесь, чтобы бот и HTTP /ingest ставили
 * джобу одинаково; ключ по itemId не даёт запустить агента дважды (design D7).
 */
export function makeResolverEnqueuer(boss: PgBoss): (job: ResolverJob) => Promise<void> {
  return async (job) => {
    await boss.send(
      AgentJobNames.runResolver,
      { ...job },
      {
        singletonKey: `agent:resolver:${job.itemId}`,
        singletonSeconds: 3600,
        retryLimit: 2,
        retryDelay: 120,
      },
    );
  };
}

export async function startBoss(boss: PgBoss): Promise<void> {
  await boss.start();
}

export async function stopBoss(boss: PgBoss): Promise<void> {
  await boss.stop({ graceful: true, timeout: 5000 });
}
