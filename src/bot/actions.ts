import type { Kysely } from "kysely";
import type { Database } from "../db/types.js";
import { calculateEditDistance } from "./diff.js";
import { updateSourceTrustOnDecision } from "./source-trust.js";
import type { RejectReasonKey } from "./taxonomy.js";
import { applyAnalystDiff, type AnalystOutput } from "../agents/analyst.js";

export interface TelegramSender {
  sendMessage(chatId: string, text: string): Promise<{ messageId: number }>;
  getChatMemberCount(chatId: string): Promise<number | null>;
}

export interface DecisionMeta {
  latencyS: number;
  forced?: boolean;
}

/**
 * Действие «Опубликовать» (как есть или с правками).
 * Сохраняет диф, edit_distance, post и обновляет source_trust.
 */
export async function publishDraft(
  db: Kysely<Database>,
  sender: TelegramSender,
  args: {
    draftId: string;
    channelId: string;
    channelChatId: string;
    editedText?: string;
  },
  meta: DecisionMeta,
): Promise<{ postId: string; tgMessageId: number }> {
  const draft = await db
    .selectFrom("drafts")
    .innerJoin("channel_candidates", "channel_candidates.id", "drafts.candidate_id")
    .innerJoin("stories", "stories.id", "channel_candidates.story_id")
    .innerJoin("items", "items.story_id", "stories.id")
    .select([
      "drafts.id",
      "drafts.text",
      "drafts.candidate_id",
      "drafts.created_at",
      "items.source_id",
    ])
    .where("drafts.id", "=", args.draftId)
    .executeTakeFirstOrThrow();

  const finalText = args.editedText ? args.editedText.trim() : draft.text;
  const editDistance = args.editedText ? calculateEditDistance(draft.text, finalText) : 0;

  const sent = await sender.sendMessage(args.channelChatId, finalText);
  const members = await sender.getChatMemberCount(args.channelChatId).catch(() => null);

  const result = await db.transaction().execute(async (trx) => {
    const post = await trx
      .insertInto("posts")
      .values({
        channel_id: args.channelId,
        draft_id: draft.id,
        tg_message_id: String(sent.messageId),
        final_text: finalText,
        subscribers_at_publish: members ?? null,
      })
      .returning("id")
      .executeTakeFirstOrThrow();

    await trx.insertInto("editorial_decisions").values({
      draft_id: draft.id,
      action: "publish",
      edited_text: args.editedText ? finalText : null,
      edit_distance: editDistance as never,
      forced: meta.forced ?? false,
      latency_s: Math.max(0, Math.round(meta.latencyS)),
    });

    await trx
      .updateTable("channel_candidates")
      .set({ status: "decided" })
      .where("id", "=", draft.candidate_id)
      .execute();

    return { postId: post.id, tgMessageId: sent.messageId };
  });

  // Обновление рейтинга источника
  if (draft.source_id) {
    await updateSourceTrustOnDecision(db, draft.source_id, "publish");
  }

  return result;
}

/**
 * Действие «Отклонить» с указанием причины из таксономии (§8.3).
 */
export async function rejectDraftWithReason(
  db: Kysely<Database>,
  draftId: string,
  reason: RejectReasonKey,
  meta: DecisionMeta,
): Promise<void> {
  const draft = await db
    .selectFrom("drafts")
    .innerJoin("channel_candidates", "channel_candidates.id", "drafts.candidate_id")
    .innerJoin("stories", "stories.id", "channel_candidates.story_id")
    .innerJoin("items", "items.story_id", "stories.id")
    .select(["drafts.id", "drafts.candidate_id", "items.source_id"])
    .where("drafts.id", "=", draftId)
    .executeTakeFirstOrThrow();

  await db.transaction().execute(async (trx) => {
    await trx.insertInto("editorial_decisions").values({
      draft_id: draft.id,
      action: "reject",
      reject_reason: reason,
      latency_s: Math.max(0, Math.round(meta.latencyS)),
      forced: meta.forced ?? false,
    });
    await trx
      .updateTable("channel_candidates")
      .set({ status: "decided" })
      .where("id", "=", draft.candidate_id)
      .execute();
  });

  if (draft.source_id) {
    await updateSourceTrustOnDecision(db, draft.source_id, "reject", reason);
  }
}

/**
 * Действие «Отложить» (возврат в пул с пониженным приоритетом).
 */
export async function deferDraft(
  db: Kysely<Database>,
  draftId: string,
  meta: DecisionMeta,
): Promise<void> {
  const draft = await db
    .selectFrom("drafts")
    .select(["id", "candidate_id"])
    .where("id", "=", draftId)
    .executeTakeFirstOrThrow();

  await db.transaction().execute(async (trx) => {
    await trx.insertInto("editorial_decisions").values({
      draft_id: draft.id,
      action: "defer",
      latency_s: Math.max(0, Math.round(meta.latencyS)),
    });
    await trx
      .updateTable("channel_candidates")
      .set({ status: "pool", priority: "normal" })
      .where("id", "=", draft.candidate_id)
      .execute();
  });
}

export async function rejectDraft(
  db: Kysely<Database>,
  draftId: string,
  meta: DecisionMeta,
): Promise<void> {
  return rejectDraftWithReason(db, draftId, "off_topic", meta);
}

export type AnalystDecision = "accepted" | "rejected";

export type AnalystDecisionOutcome =
  | "applied"
  | "rejected"
  | "not_found"
  | "already_decided";

/**
 * Решение владельца по предложению Analyst (M4, Task 4.6).
 * Атомарно забирает предложение в статус принят/отклонён (защита от двойного
 * нажатия), затем applyAnalystDiff создаёт новую версию профиля.
 */
export async function decideAnalystProposal(
  db: Kysely<Database>,
  proposalId: string,
  decision: AnalystDecision,
): Promise<{ outcome: AnalystDecisionOutcome; newVersion?: number }> {
  const claimed = await db
    .updateTable("profile_proposals")
    .set({
      status: decision,
      decided_at: new Date(),
    })
    .where("id", "=", proposalId)
    .where("status", "=", "pending")
    .returning(["channel_id", "proposed_diff", "summary"])
    .executeTakeFirst();

  if (!claimed) {
    const exists = await db
      .selectFrom("profile_proposals")
      .select("id")
      .where("id", "=", proposalId)
      .executeTakeFirst();
    return exists ? { outcome: "already_decided" } : { outcome: "not_found" };
  }

  if (decision === "rejected") {
    return { outcome: "rejected" };
  }

  try {
    const { newVersion } = await applyAnalystDiff(
      db,
      claimed.channel_id,
      claimed.proposed_diff as AnalystOutput["proposedDiff"],
      `Analyst (${proposalId.slice(0, 8)}): ${claimed.summary}`.slice(0, 500),
    );
    return { outcome: "applied", newVersion };
  } catch (err) {
    // Профиль не создан — возвращаем предложение в pending, чтобы владелец мог повторить
    await db
      .updateTable("profile_proposals")
      .set({ status: "pending", decided_at: null })
      .where("id", "=", proposalId)
      .execute();
    throw err;
  }
}
