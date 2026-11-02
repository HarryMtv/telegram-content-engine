import { z } from 'zod';
import type { Kysely } from 'kysely';
import type { Database } from '../db/types.js';
import type { LlmClient } from '../llm/client.js';
import { runAgent, type AgentTool } from './runtime.js';
import {
  searchSources,
  checkDuplicate,
  submitItem,
  getChannelProfile,
  webSearch,
  SearchSourcesInput,
  CheckDuplicateInput,
  SubmitItemInput,
  GetChannelProfileInput,
  WebSearchInput,
} from './tools/index.js';
import type { SearchProvider } from '../search/index.js';

export const ScoutInput = z.object({
  topicHint: z.string().optional(),
  maxCandidates: z.number().int().default(3),
});
export type ScoutInput = z.infer<typeof ScoutInput>;

export const ScoutOutput = z.object({
  foundItems: z.array(
    z.object({
      url: z.string().url(),
      title: z.string(),
      relevanceScore: z.number(),
      reasoning: z.string(),
    }),
  ),
  summary: z.string(),
});
export type ScoutOutput = z.infer<typeof ScoutOutput>;

/**
 * Scout Agent (M4, Task 4.5):
 * Выполняет поиск трендовых тем и находок, проверяет на дубликаты и отправляет в submissions.
 */
export async function runScoutAgent(
  db: Kysely<Database>,
  llm: LlmClient,
  input: ScoutInput,
  searchProvider?: SearchProvider,
): Promise<ScoutOutput> {
  const tools: AgentTool<any, any>[] = [
    {
      name: 'get_channel_profile',
      description: 'Получение правил отбора и профиля канала. Вход: { channelId?: string }',
      schema: GetChannelProfileInput,
      execute: (args) => getChannelProfile(db, args),
    },
    ...(searchProvider
      ? [
          {
            name: 'web_search',
            description: 'Поиск свежих материалов, статей и трендов в интернете через поисковик. Вход: { query: string, limit?: number }',
            schema: WebSearchInput,
            execute: (args: WebSearchInput) => webSearch(searchProvider, args),
          },
        ]
      : []),
    {
      name: 'search_sources',
      description: 'Поиск по существующей базе материалов. Вход: { query: string, limit?: number }',
      schema: SearchSourcesInput,
      execute: (args) => searchSources(db, args),
    },
    {
      name: 'check_duplicate',
      description: 'Проверка ссылки на дубликат. Вход: { url?: string, title?: string }',
      schema: CheckDuplicateInput,
      execute: (args) => checkDuplicate(db, args),
    },
    {
      name: 'submit_item',
      description: 'Отправка найденного материала в конвейер обработки. Вход: { url: string, title: string, rawText?: string, priority?: "normal" | "high" }',
      schema: SubmitItemInput,
      execute: (args) => submitItem(db, args),
    },
  ];

  const systemPrompt =
    `Ты — агент Scout для скаутинга свежих и важных тем в области ИИ и технологий.\n` +
    `Твоя задача:\n` +
    `1. Изучи профиль и правила отбора канала через get_channel_profile.\n` +
    `2. Найди новые темы в интернете через web_search (или в базе через search_sources, check_duplicate).\n` +
    `3. Отправь лучшие находки в конвейер через submit_item.\n` +
    `4. Верни структурированный FINAL_ANSWER с перечнем найденных материалов.`;

  const dateStr = new Date().toISOString().slice(0, 10);
  const idempotencyKey = `scout:${input.topicHint || 'weekly'}:${dateStr}`;

  const result = await runAgent({
    agentName: 'scout',
    idempotencyKey,
    systemPrompt,
    inputPayload: input,
    tools,
    outputSchema: ScoutOutput,
    maxSteps: 8,
    maxTimeoutMs: 60000,
    llm,
    db,
  });

  if (result.ok && result.output) {
    return result.output;
  }

  return {
    foundItems: [],
    summary: result.error || 'Скаутинг не дал результатов',
  };
}
