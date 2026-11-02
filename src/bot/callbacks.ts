import type { RejectReasonKey } from "./taxonomy.js";

/** Кодирование действий батча в callback_data Telegram (лимит 64 байта). */
export type BatchAction =
  | "publish"
  | "edit"
  | "more"
  | "strong"
  | "reject"
  | "rej_r"
  | "defer";

export interface DecodedCallback {
  action: BatchAction;
  draftId: string;
  reason?: RejectReasonKey;
}

export function encodeCallback(
  draftId: string,
  action: BatchAction,
  reason?: RejectReasonKey,
): string {
  let data = `${action}:${draftId}`;
  if (action === "rej_r" && reason) {
    data = `rej_r:${reason}:${draftId}`;
  }
  if (data.length > 64) throw new Error(`callback_data слишком длинный: ${data.length}`);
  return data;
}

export function decodeCallback(data: string): DecodedCallback | null {
  // rej_r:<reason>:<uuid>
  const matchReason = /^rej_r:([a-z_]+):([0-9a-f-]{36})$/.exec(data);
  if (matchReason && matchReason[1] && matchReason[2]) {
    return {
      action: "rej_r",
      reason: matchReason[1] as RejectReasonKey,
      draftId: matchReason[2],
    };
  }

  // <action>:<uuid>
  const matchSimple = /^(publish|edit|more|strong|reject|defer):([0-9a-f-]{36})$/.exec(data);
  if (!matchSimple || !matchSimple[1] || !matchSimple[2]) return null;

  return {
    action: matchSimple[1] as BatchAction,
    draftId: matchSimple[2],
  };
}

/**
 * Нажал ли кнопку владелец (TELEGRAM_OWNER_CHAT_ID).
 * Кнопки батча уходят только в чат владельца, но callback_query может прислать
 * любой пользователь бота — без явной проверки посторонний способен нажать кнопку.
 */
export function isOwner(fromId: number | undefined, ownerChatId: string): boolean {
  return fromId !== undefined && String(fromId) === ownerChatId;
}
