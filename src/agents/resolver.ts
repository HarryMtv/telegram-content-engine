import { z } from 'zod';
import { sql } from 'kysely';
import type { Kysely } from 'kysely';
import type { Database } from '../db/types.js';
import type { LlmClient } from '../llm/client.js';
import { runAgent, type AgentTool } from './runtime.js';
import {
  searchSources,
  checkDuplicate,
  webSearch,
  SearchSourcesInput,
  CheckDuplicateInput,
  WebSearchInput,
} from './tools/index.js';
import type { SearchProvider } from '../search/index.js';

export const ResolverInput = z.object({
  itemId: z.string().uuid(),
  text: z.string().min(1),
  channelTitle: z.string().optional(),
});
export type ResolverInput = z.infer<typeof ResolverInput>;

export const ResolverOutput = z.object({
  found: z.boolean(),
  primaryUrl: z.string().url().optional(),
  sourceName: z.string().optional(),
  confidence: z.number().min(0).max(1),
  summary: z.string(),
});
export type ResolverOutput = z.infer<typeof ResolverOutput>;

/**
 * Resolver Agent (M4, Task 4.4):
 * Ищет первоисточник для постов-наводок из Telegram без ссылок (≤N попыток).
 */
export async function runResolverAgent(
  db: Kysely<Database>,
  llm: LlmClient,
  input: ResolverInput,
  searchProvider?: SearchProvider,
): Promise<ResolverOutput> {
  const tools: AgentTool<any, any>[] = [
    ...(searchProvider
      ? [
          {
            name: 'web_search',
            description: 'Поиск первоисточника в интернете по цитате, проекту, авторам или заголовку. Вход: { query: string, limit?: number }',
            schema: WebSearchInput,
            execute: (args: WebSearchInput) => webSearch(searchProvider, args),
          },
        ]
      : []),
    {
      name: 'search_sources',
      description: 'Поиск похожих материалов в базе по ключевым словам. Вход: { query: string, limit?: number }',
      schema: SearchSourcesInput,
      execute: (args) => searchSources(db, args),
    },
    {
      name: 'check_duplicate',
      description: 'Проверка ссылки на дубликат. Вход: { url?: string, title?: string }',
      schema: CheckDuplicateInput,
      execute: (args) => checkDuplicate(db, args),
    },
  ];

  const systemPrompt =
    `Ты — исследовательский агент Resolver для поиска первоисточников новостей.\n` +
    `Твоя цель: по тексту русскоязычной наводки или пересказа из Telegram найти оригинальный первоисточник (GitHub, ArXiv, блог компании, научная статья).\n` +
    `1. Извлеки ключевые сущности (название проекта, авторы, технология).\n` +
    `2. Найди первоисточник в интернете через web_search (или в базе через search_sources) и проверь на дубликаты через check_duplicate.\n` +
    `3. Верни FINAL_ANSWER с найденным primaryUrl и confidence (0.0-1.0) или found: false.`;

  // external_signals хранит внешние прокси виральности (§15: очки HN, звёзды, karma).
  // Флаги первоисточника живут в том же jsonb, поэтому дописываем ключи,
  // а не перезаписываем объект целиком.
  const withPrimarySourceFound = sql`(coalesce(external_signals, '{}'::jsonb) - 'no_primary_source'::text) || '{"resolved_primary_source": 1}'::jsonb`;
  const withPrimarySourceMissing = sql`coalesce(external_signals, '{}'::jsonb) || '{"no_primary_source": 1}'::jsonb`;

  const idempotencyKey = `resolver:${input.itemId}`;

  const result = await runAgent({
    agentName: 'resolver',
    idempotencyKey,
    systemPrompt,
    inputPayload: input,
    tools,
    outputSchema: ResolverOutput,
    maxSteps: 5,
    maxTimeoutMs: 30000,
    llm,
    db,
  });

  if (result.ok && result.output) {
    if (result.output.found && result.output.primaryUrl) {
      // Обновляем item: привязываем primary_url и убираем статус no_primary_source
      await db
        .updateTable('items')
        .set({
          canonical_url: result.output.primaryUrl,
          external_signals: withPrimarySourceFound as never,
        })
        .where('id', '=', input.itemId)
        .execute();

      // Обновляем FactSheet соответствующей Story, если он уже создан (Task 4.4, §5.3, §8)
      const item = await db
        .selectFrom('items')
        .select('story_id')
        .where('id', '=', input.itemId)
        .executeTakeFirst();

      if (item?.story_id) {
        await db
          .updateTable('fact_sheets')
          .set({ primary_url: result.output.primaryUrl })
          .where('story_id', '=', item.story_id)
          .execute();
      }
    } else {
      // Если первоисточник не найден — помечаем no_primary_source
      await db
        .updateTable('items')
        .set({
          external_signals: withPrimarySourceMissing as never,
        })
        .where('id', '=', input.itemId)
        .execute();
    }
    return result.output;
  }

  // При ошибке исполнения агента также фиксируем no_primary_source
  await db
    .updateTable('items')
    .set({
      external_signals: withPrimarySourceMissing as never,
    })
    .where('id', '=', input.itemId)
    .execute()
    .catch(() => undefined);

  return {
    found: false,
    confidence: 0,
    summary: result.error || 'Первоисточник не найден в пределах лимита шагов',
  };
}
