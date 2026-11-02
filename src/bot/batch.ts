import type { InlineKeyboardButton } from "grammy/types";
import { encodeCallback } from "./callbacks.js";
import { REJECT_REASONS, type RejectReasonKey } from "./taxonomy.js";

export interface BatchCandidateView {
  draftId: string;
  text: string;
  url: string;
  scoreTotal: number | null;
  components?: Record<string, number>;
  triageReason?: string;
  confidence?: number;
}

const SCORE_LABEL: Record<string, string> = {
  relevance: "релевантность",
  novelty: "новизна",
  importance: "важность",
  freshness: "свежесть",
  trust: "источник",
};

export function formatCandidateMessage(view: BatchCandidateView): string {
  const parts: string[] = [];
  if (view.scoreTotal !== null) {
    const comp = view.components
      ? Object.entries(view.components)
          .filter(([k]) => SCORE_LABEL[k])
          .map(([k, v]) => `${SCORE_LABEL[k]}: ${Number(v).toFixed(2)}`)
          .join(" · ")
      : "";
    parts.push(`⭐ ${Number(view.scoreTotal).toFixed(2)}${comp ? ` (${comp})` : ""}`);
  }

  if (view.triageReason) {
    parts.push(`💡 Триаж: ${view.triageReason}`);
  }

  if (typeof view.confidence === "number" && view.confidence < 0.8) {
    parts.push(`⚠️ Внимание: фактчек выявил расхождения (уверенность ${Math.round(view.confidence * 100)}%)`);
  }

  parts.push(view.text);
  return parts.join("\n\n");
}

/** Полная Inline-клавиатура M2: 6 действий над черновиком (спека §8.2). */
export function candidateKeyboard(draftId: string): InlineKeyboardButton[][] {
  return [
    [
      { text: "✅ Опубликовать", callback_data: encodeCallback(draftId, "publish") },
      { text: "✏️ Править", callback_data: encodeCallback(draftId, "edit") },
    ],
    [
      { text: "🔄 Ещё вариант", callback_data: encodeCallback(draftId, "more") },
      { text: "⚡ Переписать лучше", callback_data: encodeCallback(draftId, "strong") },
    ],
    [
      { text: "❌ Отклонить", callback_data: encodeCallback(draftId, "reject") },
      { text: "⏳ Отложить", callback_data: encodeCallback(draftId, "defer") },
    ],
  ];
}

/** Клавиатура выбора причины отклонения (таксономия §8.3). */
export function rejectReasonsKeyboard(draftId: string): InlineKeyboardButton[][] {
  const buttons: InlineKeyboardButton[][] = [];
  const entries = Object.entries(REJECT_REASONS) as Array<[RejectReasonKey, typeof REJECT_REASONS[RejectReasonKey]]>;

  for (let i = 0; i < entries.length; i += 2) {
    const row: InlineKeyboardButton[] = [];
    const [k1, d1] = entries[i]!;
    row.push({ text: d1.label, callback_data: encodeCallback(draftId, "rej_r", k1) });

    if (entries[i + 1]) {
      const [k2, d2] = entries[i + 1]!;
      row.push({ text: d2.label, callback_data: encodeCallback(draftId, "rej_r", k2) });
    }
    buttons.push(row);
  }

  buttons.push([{ text: "🔙 Назад", callback_data: encodeCallback(draftId, "more") }]);
  return buttons;
}
