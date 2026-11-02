import { z } from 'zod';
import type { Kysely } from 'kysely';
import type { Database } from '../db/types.js';
import type { LlmClient } from '../llm/client.js';
import { runAgent, type AgentTool } from './runtime.js';
import {
  getPublishedHistory,
  getChannelProfile,
  GetPublishedHistoryInput,
  GetChannelProfileInput,
} from './tools/index.js';

export const AnalystInput = z.object({
  channelId: z.string().uuid().optional(),
  days: z.number().int().default(7),
});
export type AnalystInput = z.infer<typeof AnalystInput>;

export const AnalystOutput = z.object({
  analysisPeriodDays: z.number(),
  summary: z.string(),
  proposedDiff: z.object({
    selectionRulesDiff: z.array(z.string()).optional(),
    taboosDiff: z.array(z.string()).optional(),
    styleGuideDiff: z.string().optional(),
    weightsDiff: z.record(z.number()).optional(),
  }),
  justification: z.string(),
});
export type AnalystOutput = z.infer<typeof AnalystOutput>;

/**
 * Analyst Agent (M4, Task 4.6):
 * Недельный разбор редакционных решений, причин отказов, правок редактора и метрик.
 * Предлагает диф к профилю канала (конституция, веса) для аппрува владельцем.
 */
export async function runAnalystAgent(
  db: Kysely<Database>,
  llm: LlmClient,
  input: AnalystInput,
): Promise<AnalystOutput> {
  const tools: AgentTool<any, any>[] = [
    {
      name: 'get_channel_profile',
      description: 'Получение текущей конституции и весов канала. Вход: { channelId?: string }',
      schema: GetChannelProfileInput,
      execute: (args) => getChannelProfile(db, args),
    },
    {
      name: 'get_published_history',
      description: 'Получение истории опубликованных постов с метриками и решениями. Вход: { days?: number, limit?: number }',
      schema: GetPublishedHistoryInput,
      execute: (args) => getPublishedHistory(db, args),
    },
  ];

  const systemPrompt =
    `Ты — агент Analyst для эволюции редполитики и конституции канала.\n` +
    `Твоя цель:\n` +
    `1. Запроси текущий профиль канала через get_channel_profile.\n` +
    `2. Запроси историю публикаций и метрик через get_published_history.\n` +
    `3. Проанализируй паттерны (какие темы набрали больше просмотров/ERR, какие отклонялись или правились).\n` +
    `4. Сформируй конкретное предложение по улучшению правил (proposedDiff) с понятным обоснованием (justification).\n` +
    `5. Верни структурированный FINAL_ANSWER.`;

  const dateStr = new Date().toISOString().slice(0, 10);
  const idempotencyKey = `analyst:${input.channelId || 'global'}:${dateStr}`;

  const result = await runAgent({
    agentName: 'analyst',
    idempotencyKey,
    systemPrompt,
    inputPayload: input,
    tools,
    outputSchema: AnalystOutput,
    maxSteps: 6,
    maxTimeoutMs: 60000,
    llm,
    db,
  });

  if (result.ok && result.output) {
    return result.output;
  }

  return {
    analysisPeriodDays: input.days,
    summary: result.error || 'Анализ не завершился успешно',
    proposedDiff: {},
    justification: 'Недостаточно данных для формирования предложений',
  };
}

/**
 * Применение одобренного владельцем дифа от Analyst (Task 4.6).
 * Создаёт новую версию профиля version + 1 с changelog.
 */
export async function applyAnalystDiff(
  db: Kysely<Database>,
  channelId: string,
  diff: AnalystOutput['proposedDiff'],
  changelog: string,
): Promise<{ newVersion: number }> {
  const current = await db
    .selectFrom('channel_profiles')
    .selectAll()
    .where('channel_id', '=', channelId)
    .orderBy('version', 'desc')
    .limit(1)
    .executeTakeFirstOrThrow();

  const newVersion = current.version + 1;
  const currentSelectionRules = typeof current.selection_rules === 'string'
    ? current.selection_rules
    : JSON.stringify(current.selection_rules);
  const newSelectionRules = diff.selectionRulesDiff
    ? diff.selectionRulesDiff.join('\n')
    : currentSelectionRules;
  const newTaboos = diff.taboosDiff ?? (current.taboos as string[]);
  const newStyleGuide = diff.styleGuideDiff ?? current.style_guide;
  const currentWeights = (current.score_weights as Record<string, number>) ?? {};
  const newWeights = diff.weightsDiff
    ? { ...currentWeights, ...diff.weightsDiff }
    : currentWeights;

  await db
    .insertInto('channel_profiles')
    .values({
      channel_id: channelId,
      version: newVersion,
      manifesto: current.manifesto,
      selection_rules: newSelectionRules,
      taboos: newTaboos as never,
      style_guide: newStyleGuide,
      domain_blacklist: current.domain_blacklist as never,
      score_weights: newWeights as never,
      profile_vector: current.profile_vector,
      created_at: new Date(),
      created_by: 'analyst',
      changelog,
    })
    .execute();

  return { newVersion };
}

/** Проверяет, содержит ли предложенный диф от Analyst хотя бы одно непустое изменение. */
export function hasProposedDiff(diff: AnalystOutput['proposedDiff']): boolean {
  return Boolean(
    diff.styleGuideDiff
    || (diff.selectionRulesDiff && diff.selectionRulesDiff.length > 0)
    || (diff.taboosDiff && diff.taboosDiff.length > 0)
    || (diff.weightsDiff && Object.keys(diff.weightsDiff).length > 0),
  );
}
