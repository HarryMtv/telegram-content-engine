import type { Bot } from 'grammy';
import type { Kysely } from 'kysely';
import type PgBoss from 'pg-boss';
import type { Database } from '../db/types.js';
import type { loadConfig } from '../config.js';
import { processIngest } from '../ingest/service.js';
import { createEmbeddingProvider } from '../embeddings/factory.js';
import { calculateEditDistance } from './diff.js';
import { JobNames, makeResolverEnqueuer, type FetchItemJob, type BuildBatchJob } from '../queue/index.js';

export function registerMessageHandlers(
  bot: Bot,
  db: Kysely<Database>,
  config: ReturnType<typeof loadConfig>,
  boss?: PgBoss,
): void {
  const embeddingProvider = createEmbeddingProvider({
    provider: config.embeddingProvider,
    model: config.embeddingModel,
    apiKey: config.embeddingApiKey || config.cohereApiKey || config.openAiApiKey,
    baseUrl: config.embeddingBaseUrl,
    dimensions: config.embeddingDimensions,
  });
  bot.command('start', async (ctx) => {
    const isOwner = String(ctx.from?.id) === config.telegramOwnerChatId;
    if (isOwner) {
      await ctx.reply(
        '👋 **Добро пожаловать в Content Engine!**\n\n' +
          'Вы являетесь **владельцем / редактором** канала.\n\n' +
          '📥 **Что можно отправлять:**\n' +
          '• Любую ссылку или список ссылок в столбик\n' +
          '• Пересланный пост из любого канала\n' +
          '• Текстовую заметку или мысль\n' +
          '• Файл `.txt` / `.md` со ссылками или текстом\n\n' +
          '⚙️ **Модификаторы (опционально):**\n' +
          '• `--priority=high` или `--high` — внеочередная обработка\n' +
          '• `--force` — форсированное добавление даже при совпадении с дублем\n' +
          '• `--channel=<id>` — привязка к конкретному каналу\n\n' +
          '✏️ **Редактирование черновиков:**\n' +
          'Просто ответьте реплаем на любое сообщение с черновиком, чтобы предложить свой вариант текста.',
        { parse_mode: 'Markdown' },
      );
    } else {
      await ctx.reply(
        '👋 **Привет! Это бот предложки канала.**\n\n' +
          'Отправьте ссылку или новость, и редакция рассмотрит ваш материал для публикации.',
      );
    }
  });

  bot.command('stats', async (ctx) => {
    const isOwner = String(ctx.from?.id) === config.telegramOwnerChatId;
    if (!isOwner) {
      await ctx.reply('⚠️ Команда доступна только администратору.');
      return;
    }

    const { count: totalItems } = await db
      .selectFrom('items')
      .select((eb) => eb.fn.countAll<string>().as('count'))
      .executeTakeFirstOrThrow();

    const { count: totalDrafts } = await db
      .selectFrom('drafts')
      .select((eb) => eb.fn.countAll<string>().as('count'))
      .executeTakeFirstOrThrow();

    const { count: totalPosts } = await db
      .selectFrom('posts')
      .select((eb) => eb.fn.countAll<string>().as('count'))
      .executeTakeFirstOrThrow();

    const { count: totalSubmissions } = await db
      .selectFrom('submissions')
      .select((eb) => eb.fn.countAll<string>().as('count'))
      .executeTakeFirstOrThrow();

    await ctx.reply(
      `📊 **Статистика контент-движка:**\n\n` +
        `• Всего материалов в базе: **${totalItems}**\n` +
        `• Сгенерировано черновиков: **${totalDrafts}**\n` +
        `• Опубликовано постов: **${totalPosts}**\n` +
        `• Ручных предложений (submissions): **${totalSubmissions}**`,
      { parse_mode: 'Markdown' },
    );
  });

  bot.on('message', async (ctx) => {
    const senderId = ctx.from?.id;
    if (!senderId) return;

    const isOwner = String(senderId) === config.telegramOwnerChatId;
    const role = isOwner ? ('owner' as const) : ('contributor' as const);

    // 1. Проверка: является ли сообщение реплаем на черновик (редакторская правка)
    const replyTo = ctx.message.reply_to_message;
    if (replyTo && replyTo.text && isOwner) {
      // Ищем черновик по тексту из сообщения, на которое ответили
      const replyTextSnippet = replyTo.text.slice(0, 100);
      const draft = await db
        .selectFrom('drafts')
        .innerJoin('channel_candidates', 'channel_candidates.id', 'drafts.candidate_id')
        .select(['drafts.id', 'drafts.text', 'drafts.candidate_id', 'channel_candidates.channel_id'])
        .where((eb) => eb('drafts.text', 'like', `%${replyTextSnippet.slice(0, 50)}%`))
        .orderBy('drafts.created_at', 'desc')
        .executeTakeFirst();

      if (draft && ctx.message.text) {
        const editedText = ctx.message.text.trim();
        const dist = calculateEditDistance(draft.text, editedText);

        await ctx.reply(
          `📝 **Получена правка черновика!**\n\n` +
            `• Дистанция правок (edit distance): **${dist}**\n\n` +
            `👇 Нажмите кнопку ниже, чтобы опубликовать отредактированную версию в канал:`,
          {
            parse_mode: 'Markdown',
            reply_markup: {
              inline_keyboard: [
                [
                  {
                    text: '🚀 Опубликовать отредактированный пост',
                    callback_data: `publish_edit:${draft.id}`,
                  },
                ],
              ],
            },
          },
        );

        // Временно сохраняем отредактированный текст как новый черновик
        await db
          .insertInto('drafts')
          .values({
            candidate_id: draft.candidate_id,
            variant_n: 99,
            model: 'manual_editor',
            profile_version: 1,
            text: editedText,
            lang: 'ru',
            cost_usd: '0' as never,
          })
          .execute();

        return;
      }
    }

    // 2. Обработка входящего материала (ссылка, пересылка, текст, файл)
    const msg = ctx.message as any;
    let messageText = ctx.message.text ?? ctx.message.caption ?? '';
    const isForward = Boolean(msg.forward_origin || msg.forward_from_chat || msg.forward_from);
    let forwardFromTitle: string | undefined = undefined;

    if (msg.forward_origin) {
      const orig = msg.forward_origin;
      if (orig.chat?.title) forwardFromTitle = orig.chat.title;
      else if (orig.sender_chat?.title) forwardFromTitle = orig.sender_chat.title;
      else if (orig.sender_user?.first_name) forwardFromTitle = orig.sender_user.first_name;
    } else if (msg.forward_from_chat) {
      forwardFromTitle = msg.forward_from_chat.title;
    }

    let isFile = false;
    if (ctx.message.document) {
      const doc = ctx.message.document;
      const fileName = doc.file_name?.toLowerCase() ?? '';
      // Если файл текстовый и меньше 1МБ
      if (
        (fileName.endsWith('.txt') || fileName.endsWith('.md') || fileName.endsWith('.json') || fileName.endsWith('.csv')) &&
        (doc.file_size ?? 0) < 1024 * 1024
      ) {
        isFile = true;
        try {
          const fileInfo = await ctx.api.getFile(doc.file_id);
          if (fileInfo.file_path) {
            const fileUrl = `https://api.telegram.org/file/bot${config.telegramBotToken}/${fileInfo.file_path}`;
            const fileRes = await fetch(fileUrl);
            const fileContent = await fileRes.text();
            messageText = fileContent;
          }
        } catch (err) {
          console.error('Failed to download document from Telegram:', err);
        }
      }
    }

    if (!messageText && !isFile) {
      return;
    }

    try {
      const ingestResult = await processIngest(db, {
        submittedBy: senderId,
        role,
        text: messageText,
        isForward,
        isFile,
        forwardFromTitle,
        embeddingProvider,
        ...(boss ? { enqueueResolver: makeResolverEnqueuer(boss) } : {}),
      });

      await ctx.reply(ingestResult.feedbackText, { parse_mode: 'Markdown' });

      // Fast-path: немедленная постановка в очередь на обработку (M3-M5)
      if (boss && ingestResult.acceptedCount > 0) {
        for (const item of ingestResult.results) {
          if (item.itemId) {
            await boss.send(
              JobNames.fetchItem,
              { itemId: item.itemId } satisfies FetchItemJob,
              { singletonKey: `fetch-item:${item.itemId}`, singletonSeconds: 3600 },
            );
          }
        }

        // Если прислал владелец — сразу ставим сборку батча
        if (role === 'owner') {
          const channel = await db.selectFrom('channels').select('id').limit(1).executeTakeFirst();
          if (channel) {
            await boss.send(
              JobNames.buildBatch,
              { channelId: channel.id } satisfies BuildBatchJob,
              { singletonKey: `build-batch:${channel.id}`, singletonSeconds: 15 },
            );
          }
        }
      }
    } catch (err) {
      console.error('Ingest processing error:', err);
      await ctx.reply(`❌ Ошибка обработки: ${err instanceof Error ? err.message : String(err)}`);
    }
  });
}
