import type { Kysely } from 'kysely';
import type { Database } from '../db/types.js';
import { canonicalizeUrl, urlHash, textHash } from '../pipeline/canonicalize-url.js';
import {
  createSubmission,
  checkContributorRateLimit,
  incrementContributorStats,
  findRecentPublicationByUrlHash,
  countRecentDomainSubmissions,
} from '../db/repo/submissions.js';
import { completeItem } from '../db/repo/items.js';
import { formatItemForEmbedding } from '../embeddings/service.js';
import type { EmbeddingProvider } from '../embeddings/types.js';
import type { ResolverJob } from '../queue/index.js';
import { parseModifiers, detectPayloadType } from './parser.js';

export interface IngestItemResult {
  inputUrl?: string | undefined;
  canonicalUrl?: string | undefined;
  urlHash?: string | undefined;
  status: 'accepted' | 'duplicate_published' | 'duplicate_pending' | 'rejected' | 'forced';
  itemId?: string | undefined;
  message: string;
  domain?: string | undefined;
}

export interface IngestResponse {
  success: boolean;
  total: number;
  acceptedCount: number;
  duplicateCount: number;
  results: IngestItemResult[];
  suggestRss?: { domain: string; count: number } | undefined;
  feedbackText: string;
}

export interface IngestOptions {
  submittedBy: bigint | number;
  role?: 'owner' | 'contributor' | 'api';
  text?: string | undefined;
  urls?: string[] | undefined;
  isForward?: boolean | undefined;
  isFile?: boolean | undefined;
  forwardFromTitle?: string | undefined;
  priority?: 'normal' | 'high' | undefined;
  force?: boolean | undefined;
  channelHint?: string | null | undefined;
  embeddingProvider?: EmbeddingProvider | undefined;
  /**
   * Постановка Resolver'а для наводок без первоисточника (спека §5.3,
   * agents/spec.md «Resolver Agent», manual-ingest/spec.md «Forwarded Message Intake»).
   * Без колбэка ингест работает как раньше — просто без поиска первоисточника.
   */
  enqueueResolver?: ((job: ResolverJob) => Promise<void>) | undefined;
}

/**
 * Гарантирует наличие системного источника 'manual' в таблице sources
 */
export async function ensureManualSource(db: Kysely<Database>): Promise<string> {
  const existing = await db
    .selectFrom('sources')
    .select('id')
    .where('adapter', '=', 'manual')
    .executeTakeFirst();

  if (existing) return existing.id;

  const inserted = await db
    .insertInto('sources')
    .values({
      type: 'api',
      adapter: 'manual',
      config: { type: 'manual' },
      status: 'healthy',
      poll_interval_s: 0,
    })
    .returning('id')
    .executeTakeFirstOrThrow();

  return inserted.id;
}

export async function processIngest(
  db: Kysely<Database>,
  options: IngestOptions,
): Promise<IngestResponse> {
  // 1. Проверка contributor-лимитов
  if (options.role === 'contributor') {
    const limitCheck = await checkContributorRateLimit(db, options.submittedBy, 10);
    if (!limitCheck.allowed) {
      const reasonMsg =
        limitCheck.reason === 'banned'
          ? '❌ Ваш аккаунт заблокирован для отправки материалов.'
          : '⚠️ Превышен дневной лимит предложений (10 в сутки). Попробуйте завтра!';
      return {
        success: false,
        total: 0,
        acceptedCount: 0,
        duplicateCount: 0,
        results: [],
        feedbackText: reasonMsg,
      };
    }
  }

  const rawText = options.text ?? '';
  const parsed = parseModifiers(rawText);
  const priority = options.priority ?? parsed.priority;
  const force = options.force ?? parsed.force;
  const channelHint = options.channelHint ?? parsed.channelHint;

  // Извлечение ссылок
  const detected = detectPayloadType({
    text: parsed.cleanText,
    isForward: options.isForward,
    isFile: options.isFile,
  });

  const urlsToProcess = options.urls && options.urls.length > 0 ? options.urls : detected.urls;
  const manualSourceId = await ensureManualSource(db);

  const results: IngestItemResult[] = [];
  const domainsCounted = new Set<string>();
  let suggestRss: { domain: string; count: number } | undefined = undefined;

  const isUuid = (str?: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(str ?? '');
  const validChannelHint = isUuid(channelHint) ? channelHint : null;
  const submissionRole: 'owner' | 'contributor' = options.role === 'contributor' ? 'contributor' : 'owner';

  if (urlsToProcess.length > 0) {
    for (const rawUrl of urlsToProcess) {
      try {
        const canonical = canonicalizeUrl(rawUrl);
        const hash = urlHash(canonical);
        const domain = new URL(canonical).hostname.replace(/^www\./, '');

        // Мгновенная проверка на дубликаты
        const existingPub = await findRecentPublicationByUrlHash(db, hash);
        if (existingPub && !force) {
          const daysAgo = existingPub.publishedAt
            ? Math.round((Date.now() - new Date(existingPub.publishedAt).getTime()) / (24 * 3600 * 1000))
            : null;
          const daysStr = daysAgo !== null && daysAgo >= 0 ? `${daysAgo} дн. назад` : 'ранее';

          results.push({
            inputUrl: rawUrl,
            canonicalUrl: canonical,
            urlHash: hash,
            status: 'duplicate_published',
            itemId: existingPub.itemId,
            message: `⚠️ Уже публиковалось ${daysStr}: "${existingPub.title.slice(0, 60)}"`,
            domain,
          });

          await createSubmission(db, {
            submittedBy: options.submittedBy,
            role: submissionRole,
            payloadType: detected.payloadType,
            raw: rawUrl,
            channelHint: validChannelHint,
            priority,
            status: 'duplicate',
            itemId: existingPub.itemId,
          });
          continue;
        }

        // Проверка в items на pending/processing
        const existingItem = await db
          .selectFrom('items')
          .select(['id', 'title', 'fetch_status'])
          .where('url_hash', '=', hash)
          .executeTakeFirst();

        if (existingItem && !force) {
          results.push({
            inputUrl: rawUrl,
            canonicalUrl: canonical,
            urlHash: hash,
            status: 'duplicate_pending',
            itemId: existingItem.id,
            message: `🔁 Уже находится в обработке: "${existingItem.title.slice(0, 60)}"`,
            domain,
          });

          await createSubmission(db, {
            submittedBy: options.submittedBy,
            role: submissionRole,
            payloadType: detected.payloadType,
            raw: rawUrl,
            channelHint: validChannelHint,
            priority,
            status: 'duplicate',
            itemId: existingItem.id,
          });
          continue;
        }

        // Создаём новый item
        const now = new Date();
        const insertedItem = await db
          .insertInto('items')
          .values({
            source_id: manualSourceId,
            external_id: hash,
            canonical_url: canonical,
            url_hash: hash,
            title: parsed.cleanText.length > 0 && parsed.cleanText !== rawUrl ? parsed.cleanText.slice(0, 200) : rawUrl,
            body_text: options.isForward && options.forwardFromTitle ? `[Переслано из ${options.forwardFromTitle}]\n${parsed.cleanText}` : parsed.cleanText,
            lang: 'ru',
            published_at: now,
            discovered_at: now,
            fetch_status: 'pending',
          })
          .onConflict((oc) =>
            oc.columns(['source_id', 'external_id']).doUpdateSet({
              fetch_status: 'pending',
              discovered_at: now,
            }),
          )
          .returning('id')
          .executeTakeFirstOrThrow();

        await createSubmission(db, {
          submittedBy: options.submittedBy,
          role: submissionRole,
          payloadType: detected.payloadType,
          raw: rawUrl,
          channelHint: validChannelHint,
          priority: force ? 'high' : priority,
          status: 'ingested',
          itemId: insertedItem.id,
        });

        if (options.role === 'contributor') {
          await incrementContributorStats(db, options.submittedBy, false);
        }

        // Проверка счётчика доменов (Task 3.6)
        if (!domainsCounted.has(domain)) {
          domainsCounted.add(domain);
          const domainCount = await countRecentDomainSubmissions(db, domain, 30);
          if (domainCount >= 3) {
            suggestRss = { domain, count: domainCount };
          }
        }

        results.push({
          inputUrl: rawUrl,
          canonicalUrl: canonical,
          urlHash: hash,
          status: force ? 'forced' : 'accepted',
          itemId: insertedItem.id,
          message: `✅ Добавлено в конвейер (${domain})`,
          domain,
        });
      } catch (err) {
        results.push({
          inputUrl: rawUrl,
          status: 'rejected',
          message: `❌ Ошибка обработки URL: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }
  } else if (parsed.cleanText.length > 0) {
    // Чистый текст / заметка / пересланный пост без явных ссылок
    const hash = textHash(parsed.cleanText);
    const now = new Date();
    const forwardTitle = options.forwardFromTitle ? `[Переслано: ${options.forwardFromTitle}] ` : '';
    const cleanTitle = parsed.cleanText.slice(0, 80).replace(/[\r\n]+/g, ' ').trim();
    const title = `${forwardTitle}${cleanTitle}` || 'Текстовый материал';
    const bodyText = options.isForward && options.forwardFromTitle
      ? `[Переслано из ${options.forwardFromTitle}]\n${parsed.cleanText}`
      : parsed.cleanText;

    // Векторизация и инкрементальная семантическая кластеризация материала (спека §6.3)
    let embedding: number[] | null = null;
    if (options.embeddingProvider) {
      try {
        const [vec] = await options.embeddingProvider.embed([formatItemForEmbedding(title, bodyText)]);
        embedding = vec ?? null;
      } catch (err) {
        console.error('[ingest] Ошибка генерации эмбеддинга для текста:', err);
      }
    }

    const canonicalUrl = `https://t.me/submission/${hash.slice(0, 16)}`;

    // Вставляем материал и прогоняем через completeItem (поиск ближайшей story по pgvector или создание новой)
    const insertedItem = await db
      .insertInto('items')
      .values({
        source_id: manualSourceId,
        external_id: hash,
        canonical_url: canonicalUrl,
        url_hash: hash,
        title,
        body_text: bodyText,
        lang: 'ru',
        author: options.forwardFromTitle ?? (options.role === 'owner' ? 'Редактор' : 'Предложка'),
        published_at: now,
        discovered_at: now,
        fetch_status: 'pending',
      })
      .onConflict((oc) =>
        oc.columns(['source_id', 'external_id']).doUpdateSet({
          body_text: bodyText,
          discovered_at: now,
        }),
      )
      .returning('id')
      .executeTakeFirstOrThrow();

    const clusterResult = await completeItem(
      db,
      insertedItem.id,
      {
        sourceId: manualSourceId,
        externalId: hash,
        canonicalUrl,
        urlHash: hash,
        title,
        bodyText,
        publishedAt: now,
        discoveredAt: now,
        lang: 'ru',
        author: options.forwardFromTitle ?? (options.role === 'owner' ? 'Редактор' : 'Предложка'),
        contentHash: hash,
        fetchStatus: 'ok',
      },
      embedding,
    );

    if (clusterResult === 'discarded_duplicate' && !force) {
      results.push({
        status: 'duplicate_published',
        itemId: insertedItem.id,
        message: '⚠️ Точный дубликат текста уже есть в базе',
      });

      await createSubmission(db, {
        submittedBy: options.submittedBy,
        role: submissionRole,
        payloadType: options.isForward ? 'forward' : 'text',
        raw: parsed.cleanText,
        channelHint: validChannelHint,
        priority,
        status: 'duplicate',
        itemId: insertedItem.id,
      });
    } else {
      await createSubmission(db, {
        submittedBy: options.submittedBy,
        role: submissionRole,
        payloadType: options.isForward ? 'forward' : 'text',
        raw: parsed.cleanText,
        channelHint: validChannelHint,
        priority,
        status: 'ingested',
        itemId: insertedItem.id,
      });

      results.push({
        status: 'accepted',
        itemId: insertedItem.id,
        message: options.isForward
          ? `✅ Пересланный пост принят в конвейер (${options.forwardFromTitle || 'Telegram'})`
          : '✅ Текстовая заметка принята в конвейер',
      });

      // Пересланный пост из Telegram — это наводка, а не контент (спека §5.3):
      // ссылок в нём нет, canonical_url синтетический, поэтому запускаем Resolver.
      if (options.isForward && options.enqueueResolver) {
        await options.enqueueResolver({
          itemId: insertedItem.id,
          text: parsed.cleanText,
          ...(options.forwardFromTitle ? { channelTitle: options.forwardFromTitle } : {}),
        });
      }
    }
  }

  const acceptedCount = results.filter((r) => r.status === 'accepted' || r.status === 'forced').length;
  const duplicateCount = results.filter((r) => r.status.startsWith('duplicate')).length;

  // Форматирование обратной связи для пользователя
  let feedbackText = '';
  if (results.length === 1) {
    feedbackText = results[0]!.message;
  } else if (results.length > 1) {
    feedbackText = `📥 **Обработано материалов: ${results.length}**\n` +
      `• Принято: ${acceptedCount}\n` +
      `• Дубликатов: ${duplicateCount}\n\n` +
      results.map((r, idx) => `${idx + 1}. ${r.message}`).join('\n');
  } else {
    feedbackText = '⚠️ Пустое сообщение. Отправьте ссылку, текст или файл.';
  }

  if (suggestRss && options.role === 'owner') {
    feedbackText += `\n\n💡 _Замечено ${suggestRss.count} ссылки на домен \`${suggestRss.domain}\`. Рекомендуется подключить RSS-ленту этого сайта._`;
  }

  return {
    success: acceptedCount > 0 || duplicateCount > 0,
    total: results.length,
    acceptedCount,
    duplicateCount,
    results,
    suggestRss,
    feedbackText,
  };
}
