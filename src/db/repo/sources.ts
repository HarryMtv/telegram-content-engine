import type { Kysely } from 'kysely';
import { sql } from 'kysely';
import type { Database } from '../types.js';

/**
 * Кулдаун повторной попытки для dead-источника. В секундах, как poll_interval_s
 * в схеме: единица измерения одна на оба интервала выборки.
 */
export const DEAD_RETRY_INTERVAL_S = 6 * 60 * 60;

/**
 * Источники, которым пора на опрос (спека §3.2, tick раз в минуту).
 *
 * Интервал считаем от последней попытки, а не от последнего успеха: при ошибке
 * last_ok_at не двигается, и упавший источник числился бы просроченным каждый
 * тик. dead-источники не исключаем совсем — пробуем раз в DEAD_RETRY_INTERVAL_S,
 * чтобы источник ожил сам, когда внешний API починится (успешный опрос вернёт
 * healthy — openspec/specs/source-adapters/spec.md → «Automatic Health Recovery»).
 *
 * greatest() в Postgres игнорирует NULL, поэтому отдельная проверка is null
 * покрывает ровно случай «ни одной попытки ещё не было».
 */
export async function selectDueSources(
  db: Kysely<Database>,
): Promise<{ id: string; adapter: string }[]> {
  return db
    .selectFrom('sources')
    .select(['id', 'adapter'])
    .where(
      sql<boolean>`
        greatest(last_ok_at, last_error_at) is null
        or greatest(last_ok_at, last_error_at) + (
          case when status = 'dead'
            then make_interval(secs => ${sql.lit(DEAD_RETRY_INTERVAL_S)})
            else (poll_interval_s || ' seconds')::interval
          end
        ) < now()
      `,
    )
    .execute();
}
