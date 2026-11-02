import Fastify from 'fastify';
import { Bot, InlineKeyboard } from 'grammy';
import { loadConfig } from '../config.js';
import { createDb, closeDb } from '../db/index.js';
import { createBoss, AgentJobNames } from '../queue/index.js';
import { createLlmClient } from '../llm/factory.js';
import { createSearchProvider } from '../search/factory.js';
import { runResolverAgent, type ResolverInput } from '../agents/resolver.js';
import { runScoutAgent, type ScoutInput } from '../agents/scout.js';
import { runAnalystAgent, hasProposedDiff, type AnalystInput } from '../agents/analyst.js';
import { installProcessGuard } from './guard.js';

/**
 * Процесс worker-agents (M4, §14.4):
 * Очередь 'agents' для автономных агентов Resolver, Scout, Analyst.
 */
async function main(): Promise<void> {
  installProcessGuard('worker-agents');
  const config = loadConfig();
  const { pool, db } = createDb(config.databaseUrl);
  const bot = new Bot(config.telegramBotToken);

  const searchApiKey = config.searchProvider === 'brave' ? config.braveSearchApiKey : config.tavilyApiKey;
  const searchProvider = createSearchProvider({
    provider: config.searchProvider,
    apiKey: searchApiKey,
  });

  const llm = createLlmClient(db, {
    cheap: {
      provider: config.llmCheapProvider as any,
      model: config.llmCheapModel,
      apiKey: config.llmCheapApiKey,
      baseUrl: config.llmCheapBaseUrl,
      inputPricePerMillion: config.llmCheapInputPrice,
      outputPricePerMillion: config.llmCheapOutputPrice,
    },
    strong: {
      provider: config.llmStrongProvider as any,
      model: config.llmStrongModel,
      apiKey: config.llmStrongApiKey,
      baseUrl: config.llmStrongBaseUrl,
      inputPricePerMillion: config.llmStrongInputPrice,
      outputPricePerMillion: config.llmStrongOutputPrice,
    },
    defaultApiKey: config.openAiApiKey,
  });

  // createBoss: единый путь с api/scheduler — keepalive/idleTimeout для pooler'а и TLS к Supabase
  const boss = createBoss(config.databaseUrlDirect);
  await boss.start();

  // 1. Resolver Job
  await boss.work<ResolverInput>(AgentJobNames.runResolver, async (jobs) => {
    for (const job of jobs) {
      console.log(`[Agent] Running Resolver for item ${job.data.itemId}...`);
      const res = await runResolverAgent(db, llm, job.data, searchProvider);
      console.log(`[Agent] Resolver finished for ${job.data.itemId}: found=${res.found}, primary=${res.primaryUrl}`);
    }
  });

  // 2. Scout Job
  await boss.work<ScoutInput>(AgentJobNames.runScout, async (jobs) => {
    for (const job of jobs) {
      console.log(`[Agent] Running Scout (topic: ${job.data.topicHint || 'general'})...`);
      const res = await runScoutAgent(db, llm, job.data, searchProvider);
      console.log(`[Agent] Scout finished: found ${res.foundItems.length} new items.`);

      if (res.foundItems.length > 0) {
        const text = `🕵️ **Scout нашёл новые материалы:**\n\n` +
          res.foundItems.map((item, idx) => `${idx + 1}. [${item.title}](${item.url})\n_${item.reasoning}_`).join('\n\n');
        await bot.api.sendMessage(config.telegramOwnerChatId, text, { parse_mode: 'Markdown' }).catch(() => undefined);
      }
    }
  });

  // 3. Analyst Job
  await boss.work<AnalystInput>(AgentJobNames.runAnalyst, async (jobs) => {
    for (const job of jobs) {
      console.log(`[Agent] Running weekly Analyst report...`);
      const res = await runAnalystAgent(db, llm, job.data);
      console.log(`[Agent] Analyst report complete.`);

      const channelId = job.data.channelId
        ?? (await db
          .selectFrom('channels')
          .select('id')
          .where('status', '=', 'active')
          .orderBy('created_at')
          .executeTakeFirst())?.id;

      const text =
        `📊 **Еженедельный разбор от Analyst**\n\n` +
        `📝 **Сводка:**\n${res.summary}\n\n` +
        `💡 **Обоснование:**\n${res.justification}\n\n` +
        `🔧 **Предлагаемые изменения:**\n\`\`\`json\n${JSON.stringify(res.proposedDiff, null, 2)}\n\`\`\``;

      if (!channelId || !hasProposedDiff(res.proposedDiff)) {
        await bot.api
          .sendMessage(config.telegramOwnerChatId, `${text}\n\n(Диф пустой — предложений нет)`)
          .catch((err) => console.error('Error sending analyst report to owner:', err));
        continue;
      }

      // Предложение сохраняем: кнопка в api применит диф по id
      // (в callback_data Telegram лимит 64 байта — сам диф туда не помещается)
      const proposal = await db
        .insertInto('profile_proposals')
        .values({
          channel_id: channelId,
          proposed_diff: res.proposedDiff as never,
          summary: res.summary,
          justification: res.justification,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      console.log(`[Agent] proposal ${proposal.id} saved (channel ${channelId})`);

      const keyboard = new InlineKeyboard()
        .text('✅ Принять изменения конституции', `analyst_accept:${proposal.id}`)
        .row()
        .text('❌ Отклонить', `analyst_reject:${proposal.id}`);

      await bot.api.sendMessage(config.telegramOwnerChatId, text, {
        parse_mode: 'Markdown',
        reply_markup: keyboard,
      }).catch((err) => console.error('Error sending analyst report to owner:', err));
    }
  });

  // Health-сервер
  const app = Fastify({ logger: false });
  app.get('/health', async () => {
    await pool.query('SELECT 1');
    return { ok: true, process: 'worker-agents' };
  });

  const port = config.healthPort ? config.healthPort + 2 : 8083;
  await app.listen({ port, host: '0.0.0.0' }).catch(() => undefined);
  console.log(`worker-agents запущен (очередь agents)`);

  const shutdown = async () => {
    await boss.stop();
    await app.close();
    await closeDb({ pool, db });
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err) => {
  console.error('Fatal worker-agents error:', err);
  process.exit(1);
});
