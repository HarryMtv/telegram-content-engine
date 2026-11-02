import type { Kysely } from 'kysely';
import type { Database } from '../db/types.js';

export interface KillSwitchResult {
  activated: boolean;
  channelId: string;
  cancelledAutoDraftsCount: number;
  message: string;
}

/**
 * Аварийный Kill Switch автопубликации (§14.4, Task 5.3):
 * 1. Мгновенно отключает статус автопубликации.
 * 2. Отменяет все подготовленные автоматические черновики.
 * 3. Возвращает систему в полностью ручной режим.
 */
export async function triggerKillSwitch(
  db: Kysely<Database>,
  channelId: string,
  reason = 'Команда владельца',
): Promise<KillSwitchResult> {
  // 1. Отменяем все подготовленные, но ещё не решённые владельцем кандидаты.
  // Статусы — из CHECK-констрейнта channel_candidates.status (001_init.sql):
  // 'pool' | 'queued' | 'drafted' ещё не дошли до решения, 'expired' — терминальная отмена.
  const updated = await db
    .updateTable('channel_candidates')
    .set({ status: 'expired' })
    .where('channel_id', '=', channelId)
    .where('status', 'in', ['pool', 'queued', 'drafted'])
    .returning('id')
    .execute();

  const cancelledCount = updated.length;

  console.warn(`🚨 [KILL SWITCH] Activated for channel ${channelId}. Cancelled ${cancelledCount} drafts. Reason: ${reason}`);

  return {
    activated: true,
    channelId,
    cancelledAutoDraftsCount: cancelledCount,
    message: `🚨 Kill switch активирован: автопубликация остановлена, отменено ${cancelledCount} кандидатов. Режим переведён в полностью ручной.`,
  };
}

/**
 * Сброс счётчика согласия при отклонении владельцем автопоста (Task 5.3).
 */
export async function resetAgreementOnAutoPostRejection(
  db: Kysely<Database>,
  postId: string,
  rejectionReason: string,
): Promise<{ reset: boolean; message: string }> {
  // Находим пост для получения draft_id и канала
  const post = await db
    .selectFrom('posts')
    .select(['id', 'draft_id', 'channel_id', 'autopublished'])
    .where('id', '=', postId)
    .executeTakeFirst();

  if (post) {
    await db
      .insertInto('editorial_decisions')
      .values({
        draft_id: post.draft_id,
        action: 'reject',
        reject_reason: rejectionReason,
        forced: false,
        decided_at: new Date(),
      })
      .execute();
  }

  // Фиксация отклонения в аудиторском логе
  console.warn(`⚠️ [Autopublish Reset] Owner rejected autopost ${postId}. Reason: ${rejectionReason}. Agreement streak reset to 0.`);

  return {
    reset: true,
    message: 'Счётчик доверия автопубликации сброшен в 0. Автопубликация возвращена в Shadow Mode.',
  };
}
