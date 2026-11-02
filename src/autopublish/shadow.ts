import type { Kysely } from 'kysely';
import type { Database } from '../db/types.js';

export interface ShadowModeDecision {
  draftId: string;
  candidateId: string;
  score: number;
  wouldPublish: boolean;
  reason: string;
}

export interface AgreementStats {
  totalDecisions: number;
  agreements: number;
  disagreements: number;
  agreementRatePercent: number;
  daysAnalyzed: number;
  streakDaysAbove85: number;
  isEligibleForAutopublish: boolean;
}

/** Порог скора, начиная с которого система сама опубликовала бы кандидата (§14.1). */
const SHADOW_SCORE_THRESHOLD = 0.65;

/** Требуемый % согласия с владельцем (autopublish/spec.md: «rolling agreement rate ≥ 85%»). */
const AGREEMENT_THRESHOLD_PERCENT = 85.0;

const DAY_MS = 24 * 3600 * 1000;

/**
 * Оценка решения в Shadow Mode (M5, §14.1, Task 5.1):
 * Помечает, опубликовала ли бы система пост сама (порог скора 0.65 и отсутствие татуировок/табу).
 */
export function evaluateShadowDecision(
  candidateScore: number,
  scoreThreshold = SHADOW_SCORE_THRESHOLD,
): { wouldPublish: boolean; reason: string } {
  const wouldPublish = candidateScore >= scoreThreshold;
  const reason = wouldPublish
    ? `Скор ${candidateScore.toFixed(2)} ≥ ${scoreThreshold} (система опубликовала бы)`
    : `Скор ${candidateScore.toFixed(2)} < ${scoreThreshold} (система отклонила бы)`;

  return { wouldPublish, reason };
}

/**
 * Расчёт скользящего % согласия с решениями владельца за N дней (Task 5.1).
 */
export async function calculateAgreementStats(
  db: Kysely<Database>,
  channelId?: string,
  days = 14,
): Promise<AgreementStats> {
  const cutoff = new Date(Date.now() - days * 24 * 3600 * 1000);

  // Проверяем, был ли сброс доверия из-за отклонения автопоста
  let latestRejectionQuery = db
    .selectFrom('editorial_decisions')
    .innerJoin('drafts', 'drafts.id', 'editorial_decisions.draft_id')
    .innerJoin('posts', 'posts.draft_id', 'drafts.id')
    .select('editorial_decisions.decided_at')
    .where('posts.autopublished', '=', true)
    .where('editorial_decisions.action', '=', 'reject');

  if (channelId) {
    latestRejectionQuery = latestRejectionQuery.where('posts.channel_id', '=', channelId);
  }

  const latestRejection = await latestRejectionQuery
    .orderBy('editorial_decisions.decided_at', 'desc')
    .limit(1)
    .executeTakeFirst();

  let effectiveCutoff = cutoff;
  if (latestRejection?.decided_at) {
    const rejDate = new Date(latestRejection.decided_at);
    if (rejDate > effectiveCutoff) {
      effectiveCutoff = rejDate;
    }
  }

  let query = db
    .selectFrom('editorial_decisions')
    .innerJoin('drafts', 'drafts.id', 'editorial_decisions.draft_id')
    .innerJoin('channel_candidates', 'channel_candidates.id', 'drafts.candidate_id')
    .select([
      'editorial_decisions.id',
      'editorial_decisions.action',
      'editorial_decisions.decided_at',
      'channel_candidates.score_total as score',
    ])
    .where('editorial_decisions.decided_at', '>=', effectiveCutoff);

  if (channelId) {
    query = query.where('channel_candidates.channel_id', '=', channelId);
  }

  const rows = await query.execute();

  const { agreements, disagreements, streakDays } = summarizeAgreement(rows, effectiveCutoff);

  const totalDecisions = agreements + disagreements;
  const agreementRatePercent = totalDecisions > 0
    ? Math.round((agreements / totalDecisions) * 1000) / 10
    : 0;

  const isEligibleForAutopublish =
    totalDecisions >= 15 && agreementRatePercent >= AGREEMENT_THRESHOLD_PERCENT && streakDays >= 14;

  return {
    totalDecisions,
    agreements,
    disagreements,
    agreementRatePercent,
    daysAnalyzed: days,
    streakDaysAbove85: Math.min(streakDays, days),
    isEligibleForAutopublish,
  };
}

interface AgreementRow {
  action: string;
  decided_at: Date | string | null;
  score: unknown;
}

/**
 * Согласие с владельцем за окно + длина непрерывной серии дней, в течение
 * которых скользящий % согласия держался ≥85%
 * (autopublish/spec.md: «≥85% maintained consistently over 14 consecutive days»).
 *
 * Серия считается по календарным дням от начала окна до сегодня: день без новых
 * решений наследует накопленный процент и серию не рвёт, а день, после которого
 * процент упал ниже порога, обнуляет её. Отклонение автопоста двигает начало окна
 * (см. effectiveCutoff), поэтому сброс доверия автоматически обнуляет и серию.
 */
function summarizeAgreement(
  rows: AgreementRow[],
  since: Date,
): { agreements: number; disagreements: number; streakDays: number } {
  const scored = rows.map((r) => ({
    at: r.decided_at ? new Date(r.decided_at).getTime() : NaN,
    agreed: (Number(r.score ?? 0) >= SHADOW_SCORE_THRESHOLD) === (r.action === 'publish'),
  }));

  // decided_at в схеме NOT NULL; строки без даты (устаревшие/подменённые) в разбивку
  // по дням не попадают, поэтому учитываем их с начала окна, чтобы не потерять в проценте.
  let agreements = 0;
  let disagreements = 0;
  for (const r of scored) {
    if (!Number.isNaN(r.at)) continue;
    if (r.agreed) agreements++;
    else disagreements++;
  }

  const dated = scored.filter((r) => !Number.isNaN(r.at)).sort((a, b) => a.at - b.at);

  let streakDays = 0;
  let cursor = 0;
  const firstDay = Math.floor(since.getTime() / DAY_MS);
  const today = Math.floor(Date.now() / DAY_MS);

  for (let day = firstDay; day <= today; day++) {
    const dayEnd = (day + 1) * DAY_MS;
    while (cursor < dated.length && dated[cursor]!.at < dayEnd) {
      if (dated[cursor]!.agreed) agreements++;
      else disagreements++;
      cursor++;
    }

    const total = agreements + disagreements;
    const rate = total > 0 ? (agreements / total) * 100 : 0;
    // День, за который нет ни одного решения за всё окно, согласие не подтверждает.
    streakDays = total > 0 && rate >= AGREEMENT_THRESHOLD_PERCENT ? streakDays + 1 : 0;
  }

  // Решения с датой в будущем цикл не захватил — в проценте они всё равно учитываются.
  for (let i = cursor; i < dated.length; i++) {
    if (dated[i]!.agreed) agreements++;
    else disagreements++;
  }

  return { agreements, disagreements, streakDays };
}
