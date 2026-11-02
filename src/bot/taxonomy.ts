export type RejectReasonKey =
  | "off_topic"
  | "already_covered"
  | "boring"
  | "bad_style"
  | "unreliable_source"
  | "too_long"
  | "wrong_tone";

export interface RejectReasonDefinition {
  key: RejectReasonKey;
  label: string;
  subsystem: string;
  effectDescription: string;
}

export const REJECT_REASONS: Record<RejectReasonKey, RejectReasonDefinition> = {
  off_topic: {
    key: "off_topic",
    label: "🚫 Не по теме",
    subsystem: "profile_vector / selection_rules",
    effectDescription: "Смещает вектор канала и корректирует правила отбора",
  },
  already_covered: {
    key: "already_covered",
    label: "🔁 Уже было",
    subsystem: "dedup_window / cluster_threshold",
    effectDescription: "Увеличивает окно дедупликации и порог кластеризации",
  },
  boring: {
    key: "boring",
    label: "🥱 Не новость / скучно",
    subsystem: "importance_weight",
    effectDescription: "Повышает порог importance",
  },
  bad_style: {
    key: "bad_style",
    label: "✍️ Плохой стиль",
    subsystem: "style_guide",
    effectDescription: "Пополняет анти-паттерны в style_guide",
  },
  unreliable_source: {
    key: "unreliable_source",
    label: "⚠️ Сомнительный источник",
    subsystem: "source_trust",
    effectDescription: "Снижает рейтинг доверия (trust_score) источника",
  },
  too_long: {
    key: "too_long",
    label: "📏 Слишком длинно",
    subsystem: "target_length",
    effectDescription: "Уменьшает целевую длину формата",
  },
  wrong_tone: {
    key: "wrong_tone",
    label: "🎭 Не в тон",
    subsystem: "style_guide",
    effectDescription: "Корректирует тональность промпта канала",
  },
};
