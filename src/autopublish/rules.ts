import type { Kysely } from 'kysely';
import type { Database } from '../db/types.js';
import { calculateAgreementStats } from './shadow.js';

export interface AutopublishConditionsInput {
  channelId: string;
  sourceType: string;
  formatSlug: string;
  currentHourUtc?: number | undefined;
  whitelistedSourceTypes?: string[] | undefined;
  allowedFormats?: string[] | undefined;
  publishWindowUtc?: { startHour: number; endHour: number } | undefined;
  dailyCap?: number | undefined;
}

export interface AutopublishCheckResult {
  allowed: boolean;
  reason: string;
  checks: {
    agreementRateOk: boolean;
    sourceWhitelisted: boolean;
    formatAllowed: boolean;
    withinTimeWindow: boolean;
    dailyCapNotExceeded: boolean;
  };
}

/**
 * Проверка условий автопубликации (§14.2, Task 5.2):
 * 1. Согласие ≥ 85% за 14 дней
 * 2. Источник в whitelist
 * 3. Формат разрешён для автопостинга
 * 4. Внутри окна публикации (по умолчанию 07:00 - 20:00 UTC)
 * 5. Не превышен дневной лимит постов
 */
export async function checkAutopublishEligibility(
  db: Kysely<Database>,
  input: AutopublishConditionsInput,
): Promise<AutopublishCheckResult> {
  const stats = await calculateAgreementStats(db, input.channelId, 14);
  const agreementRateOk = stats.isEligibleForAutopublish;

  const whitelisted = input.whitelistedSourceTypes ?? ['rss', 'github_trending', 'hf_daily_papers'];
  const sourceWhitelisted = whitelisted.includes(input.sourceType);

  const allowedFormats = input.allowedFormats ?? ['digest', 'single_post', 'short_alert'];
  const formatAllowed = allowedFormats.includes(input.formatSlug);

  const currentHour = input.currentHourUtc ?? new Date().getUTCHours();
  const window = input.publishWindowUtc ?? { startHour: 6, endHour: 20 };
  const withinTimeWindow = currentHour >= window.startHour && currentHour <= window.endHour;

  // Проверка дневного лимита постов
  const todayStart = new Date();
  todayStart.setUTCHours(0, 0, 0, 0);

  const postsToday = await db
    .selectFrom('posts')
    .select((eb) => eb.fn.countAll<string>().as('count'))
    .where('channel_id', '=', input.channelId)
    .where('published_at', '>=', todayStart)
    .executeTakeFirst();

  const countToday = Number(postsToday?.count ?? '0');
  const maxDaily = input.dailyCap ?? 5;
  const dailyCapNotExceeded = countToday < maxDaily;

  const allowed =
    agreementRateOk &&
    sourceWhitelisted &&
    formatAllowed &&
    withinTimeWindow &&
    dailyCapNotExceeded;

  let reason = 'Все условия автопубликации выполнены';
  if (!agreementRateOk) {
    reason = `Недостаточный % согласия в Shadow Mode: ${stats.agreementRatePercent}% (требуется ≥85% за 14 дней)`;
  } else if (!sourceWhitelisted) {
    reason = `Тип источника "${input.sourceType}" не входит в whitelist автопубликации`;
  } else if (!formatAllowed) {
    reason = `Формат "${input.formatSlug}" не разрешён для автопубликации`;
  } else if (!withinTimeWindow) {
    reason = `Вне окна публикации (${currentHour}:00 UTC, окно ${window.startHour}:00-${window.endHour}:00 UTC)`;
  } else if (!dailyCapNotExceeded) {
    reason = `Превышен дневной лимит (${countToday}/${maxDaily} постов за сегодня)`;
  }

  return {
    allowed,
    reason,
    checks: {
      agreementRateOk,
      sourceWhitelisted,
      formatAllowed,
      withinTimeWindow,
      dailyCapNotExceeded,
    },
  };
}
