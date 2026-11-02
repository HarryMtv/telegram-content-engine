import Fastify from 'fastify';
import { loadConfig } from '../config.js';
import { createDb, closeDb } from '../db/index.js';
import { createBoss } from '../queue/index.js';
import { createMtProtoService, type MtProtoService } from '../mtproto/client.js';
import { saveMetricSnapshot } from '../metrics/snapshots.js';
import { installProcessGuard } from './guard.js';

export interface CollectPostMetricsJob {
  postId: string;
  channelUsername: string;
  messageId: number;
  offsetHours: number;
  subscribersAtPublish?: number | undefined;
}

export interface SchedulePostMetricsJob {
  postId: string;
  channelUsername: string;
  messageId: number;
  subscribersAtPublish?: number | undefined;
}

/**
 * Процесс worker-mtproto (M3, §14.3):
 * Строго 1 экземпляр, очередь 'mtproto'.
 * Сбор снапшотов метрик постов (views, forwards, reactions, ERR) на offset 1/6/24/72ч.
 */
async function main(): Promise<void> {
  installProcessGuard('worker-mtproto');
  const config = loadConfig();
  const { pool, db } = createDb(config.databaseUrl);
  const mtproto = createMtProtoService(config);

  // createBoss: единый путь с api/scheduler — keepalive/idleTimeout для pooler'а
  // (mtproto спит часами между снапшотами) и TLS к хостам Supabase
  const boss = createBoss(config.databaseUrlDirect);
  await boss.start();

  // 1. Джоба сбора метрик отдельного снапшота (offset 1, 6, 24, 72ч)
  await boss.work<CollectPostMetricsJob>('collect-post-metrics', async (jobs) => {
    for (const job of jobs) {
      const { postId, channelUsername, messageId, offsetHours, subscribersAtPublish } = job.data;
      console.log(`[MTProto] Collecting metrics for post ${postId.slice(0, 8)} (offset: ${offsetHours}h)...`);

      try {
        const stats = await mtproto.getPostStats(channelUsername, messageId);
        await saveMetricSnapshot(db, {
          postId,
          offsetHours,
          views: stats.views,
          forwards: stats.forwards,
          reactions: stats.reactions,
          subscribersAtPublish,
        });
        console.log(`✓ [MTProto] Saved snapshot for post ${postId.slice(0, 8)}: ${stats.views} views, ERR calculated.`);
      } catch (err) {
        console.error(`✗ [MTProto] Error collecting snapshot for post ${postId}:`, err);
        throw err;
      }
    }
  });

  // 2. Джоба планирования сетки снапшотов (1ч, 6ч, 24ч, 72ч) при выходе поста
  await boss.work<SchedulePostMetricsJob>('schedule-post-metrics', async (jobs) => {
    for (const job of jobs) {
      const { postId, channelUsername, messageId, subscribersAtPublish } = job.data;
      const offsets = [1, 6, 24, 72];

      for (const offset of offsets) {
        const startAfterSeconds = offset * 3600;
        await boss.send(
          'collect-post-metrics',
          {
            postId,
            channelUsername,
            messageId,
            offsetHours: offset,
            subscribersAtPublish,
          },
          {
            startAfter: startAfterSeconds,
            singletonKey: `metrics:${postId}:${offset}h`,
            retryLimit: 3,
          },
        );
      }
      console.log(`[MTProto] Scheduled 4 metric snapshots (1h/6h/24h/72h) for post ${postId.slice(0, 8)}`);
    }
  });

  // Health-сервер
  const app = Fastify({ logger: false });
  app.get('/health', async () => {
    await pool.query('SELECT 1');
    return { ok: true, process: 'worker-mtproto' };
  });

  const port = config.healthPort ? config.healthPort + 1 : 8082;
  await app.listen({ port, host: '0.0.0.0' }).catch(() => undefined);
  console.log(`worker-mtproto запущен (очередь mtproto)`);

  const shutdown = async () => {
    await boss.stop();
    await mtproto.disconnect();
    await app.close();
    await closeDb({ pool, db });
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err) => {
  console.error('Fatal worker-mtproto error:', err);
  process.exit(1);
});
