import { loadConfig } from '../config.js';
import { createDb, closeDb } from '../db/index.js';
import { createBoss, startBoss, stopBoss, ensureQueues, JobNames, AgentJobNames } from '../queue/index.js';
import type { PollSourceJob, ScoutJob, AnalystJob } from '../queue/index.js';
import { startHealthServer } from '../health.js';
import { loadChannelTuning } from '../queue/handlers.js';
import { installProcessGuard } from './guard.js';
import { selectDueSources } from '../db/repo/sources.js';

/**
 * Процесс scheduler: ставит периодические джобы (спека §3.2).
 * Тик раз в минуту диспатчит poll-джобы для источников, у которых истёк
 * poll_interval_s; build-batch ставится по cadence формата канала.
 * singletonKey защищает от параллельного дублирования (design D7).
 */
async function main(): Promise<void> {
  installProcessGuard('scheduler');
  const config = loadConfig();
  const { pool, db } = createDb(config.databaseUrl);
  const boss = createBoss(config.databaseUrlDirect);
  await startBoss(boss);
  await ensureQueues(boss);
  await startHealthServer(config.healthPort, pool, 'scheduler');

  // диспатчер опросов: сам исполняет лёгкий tick
  await boss.schedule(JobNames.tick, '* * * * *');
  await boss.work(JobNames.tick, async () => {
    const due = await selectDueSources(db);
    if (due.length > 0) {
      console.log(`[tick] источников к опросу: ${due.length} (${due.map((s) => s.adapter).join(', ')})`);
    }
    for (const s of due) {
      // retryLimit: 0 — ретрай упавшего опроса лишь накручивал бы error_count
      // теми же ошибками недоступного источника; повтор ставит следующий tick.
      await boss.send(JobNames.pollSource, { sourceId: s.id } satisfies PollSourceJob, {
        singletonKey: `poll-source:${s.id}`,
        singletonSeconds: 60,
        retryLimit: 0,
      });
    }
  });

  // дневной батч по cadence активного канала (M1 — один канал)
  const tuning = await loadChannelTuning(db);
  const cadence = await db
    .selectFrom('post_formats')
    .select('cadence')
    .where('channel_id', '=', tuning.channelId)
    .executeTakeFirst();
  const cron =
    cadence && typeof cadence.cadence === 'object' && cadence.cadence !== null &&
    'cron' in cadence && typeof (cadence.cadence as Record<string, unknown>).cron === 'string'
      ? ((cadence.cadence as Record<string, string>).cron as string)
      : '5 10 * * *';
  await boss.schedule(
    JobNames.buildBatch,
    cron,
    { channelId: tuning.channelId },
    { tz: 'Europe/Berlin', singletonKey: `build-batch:${tuning.channelId}` },
  );

  // M4 (§14.4): Scout ищет тренды ежедневно, Analyst предлагает правки
  // конституции по понедельникам (диф уходит владельцу на аппрув)
  await boss.schedule(
    AgentJobNames.runScout,
    '15 6 * * *',
    { maxCandidates: 3 } satisfies ScoutJob,
    { tz: 'Europe/Berlin', singletonKey: 'agent:scout' },
  );
  await boss.schedule(
    AgentJobNames.runAnalyst,
    '45 5 * * 1',
    { channelId: tuning.channelId, days: 7 } satisfies AnalystJob,
    { tz: 'Europe/Berlin', singletonKey: `agent:analyst:${tuning.channelId}` },
  );

  console.log(
    `scheduler запущен: tick каждую минуту, build-batch по «${cron}», scout по «15 6 * * *», analyst по «45 5 * * 1»`,
  );

  const shutdown = async () => {
    await stopBoss(boss);
    await closeDb({ pool, db });
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
