import type { Kysely } from 'kysely';
import type { Database } from '../db/types.js';

export interface MetricGuardResult {
  canUseMetricsInRanking: boolean;
  totalPosts: number;
  threshold: number;
  message: string;
}

/**
 * Guard порога метрик (§12.1, Task 3.10):
 * Реакции и ERR собираются с первого поста, но влияют на веса ранжирования
 * только после преодоления порога в 200 опубликованных постов.
 */
export async function evaluateMetricGuard(
  db: Kysely<Database>,
  threshold = 200,
): Promise<MetricGuardResult> {
  const { count } = await db
    .selectFrom('posts')
    .select((eb) => eb.fn.countAll<string>().as('count'))
    .executeTakeFirstOrThrow();

  const totalPosts = Number(count ?? '0');
  const canUseMetricsInRanking = totalPosts >= threshold;

  const message = canUseMetricsInRanking
    ? `Метрики активны в петле обратной связи (${totalPosts}/${threshold} постов)`
    : `Сбор метрик в режиме накопления (${totalPosts}/${threshold} постов до включения в петлю)`;

  return {
    canUseMetricsInRanking,
    totalPosts,
    threshold,
    message,
  };
}
