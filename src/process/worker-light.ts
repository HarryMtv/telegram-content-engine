import { Bot } from 'grammy';
import { loadConfig } from '../config.js';
import { createDb, closeDb } from '../db/index.js';
import { createBoss, startBoss, stopBoss, ensureQueues, JobNames } from '../queue/index.js';
import type { PollSourceJob, FetchItemJob, BuildBatchJob, SendBatchJob } from '../queue/index.js';
import {
  handlePollSource,
  handleFetchItem,
  handleBuildBatch,
  type HandlerDeps,
} from '../queue/handlers.js';
import { formatCandidateMessage, candidateKeyboard, type BatchCandidateView } from '../bot/batch.js';
import { startHealthServer } from '../health.js';
import { installProcessGuard } from './guard.js';

/**
 * Процесс worker-light (спека §3.2): RSS/API-адаптеры, извлечение текста,
 * сборка батча, рассылка. Все действия — джобы pg-boss, идемпотентны.
 */
async function main(): Promise<void> {
  installProcessGuard('worker-light');
  const config = loadConfig();
  const { pool, db } = createDb(config.databaseUrl);
  const boss = createBoss(config.databaseUrlDirect);
  await startBoss(boss);
  await ensureQueues(boss);
  await startHealthServer(config.healthPort, pool, 'worker-light');

  const bot = new Bot(config.telegramBotToken);
  const deps: HandlerDeps = {
    db,
    boss,
    config,
    openAiApiKey: config.openAiApiKey,
    notifyOwner: async (text) => {
      await bot.api.sendMessage(config.telegramOwnerChatId, text).catch((err) => {
        console.error('notifyOwner не доставлен', err);
      });
    },
  };

  await boss.work(JobNames.pollSource, (jobs) => {
    return Promise.all(jobs.map((job) => handlePollSource(deps, job.data as PollSourceJob)));
  });
  await boss.work(
    JobNames.fetchItem,
    { batchSize: 5 },
    (jobs) => Promise.all(jobs.map((job) => handleFetchItem(deps, job.data as FetchItemJob))),
  );
  await boss.work(JobNames.buildBatch, (jobs) => {
    return Promise.all(jobs.map(async (job) => {
      const result = await handleBuildBatch(deps, job.data as BuildBatchJob);
      console.log(`[build-batch] итог: ${result}`);
      return result;
    }));
  });
  await boss.work(JobNames.sendBatch, async (jobs) => {
    for (const job of jobs) {
      const { draftIds } = job.data as SendBatchJob;
      for (const draftId of draftIds) {
        const row = await db
          .selectFrom('drafts')
          .innerJoin('channel_candidates', 'channel_candidates.id', 'drafts.candidate_id')
          .select([
            'drafts.id',
            'drafts.text',
            'channel_candidates.score_total',
            'channel_candidates.score_components',
          ])
          .where('drafts.id', '=', draftId)
          .executeTakeFirstOrThrow();
        const view: BatchCandidateView = {
          draftId: row.id,
          text: row.text,
          url: firstUrl(row.text),
          scoreTotal: row.score_total === null ? null : Number(row.score_total),
        };
        const components = row.score_components as Record<string, number> | null;
        if (components) view.components = components;
        await bot.api.sendMessage(config.telegramOwnerChatId, formatCandidateMessage(view), {
          reply_markup: { inline_keyboard: candidateKeyboard(row.id) },
        });
        const preview = row.text.replace(/\s+/g, ' ').slice(0, 60);
        console.log(
          `[send-batch] черновик ${row.id} отправлен владельцу (score=${row.score_total === null ? '—' : Number(row.score_total).toFixed(2)}): ${preview}${row.text.length > 60 ? '…' : ''}`,
        );
      }
      void job;
    }
    return `sent`;
  });

  console.log('worker-light запущен: poll-source, fetch-item, build-batch, send-batch');

  const shutdown = async () => {
    await stopBoss(boss);
    await closeDb({ pool, db });
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

function firstUrl(text: string): string {
  return /(https?:\/\/\S+)/.exec(text)?.[1] ?? '';
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
