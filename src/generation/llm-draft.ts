import type { Kysely } from "kysely";
import type { Database } from "../db/types.js";
import type { LlmClient } from "../llm/client.js";
import type { FactSheetData } from "./factsheet.js";
import { TELEGRAM_MESSAGE_LIMIT } from "./template-draft.js";

export interface GenerateDraftOptions {
  candidateId: string;
  factSheetId: string;
  factSheet: FactSheetData;
  format: {
    id?: string;
    slug: string;
    targetLength?: number;
    promptTemplate?: string;
  };
  profile: {
    version?: number;
    styleGuide?: string;
    taboos?: string[];
  };
  fewShotExamples?: Array<{ text: string }>;
  variantN?: number;
  modelRole?: "cheap" | "strong";
  channelId?: string;
}

export interface GeneratedDraftResult {
  id: string;
  text: string;
  variantN: number;
  model: string;
  costUsd: number;
}

/**
 * Генерация черновика поста из FactSheet (спека §7.2, Task 2.10).
 * Использует дешёвую модель по умолчанию (или сильную при переписывании).
 * Учитывает style_guide, taboos, target_length и few-shot примеры.
 */
export async function generateLlmDraft(
  llm: LlmClient,
  db: Kysely<Database>,
  options: GenerateDraftOptions,
): Promise<GeneratedDraftResult> {
  const role = options.modelRole ?? "cheap";
  const variantN = options.variantN ?? 1;
  const targetLength = options.format.targetLength ?? 1024;
  const taboos = options.profile.taboos ?? [];
  const styleGuide = options.profile.styleGuide ?? "Пиши чётко, информативно и без кликбейта на русском языке.";
  const examples = options.fewShotExamples ?? [];

  const tabooClause = taboos.length > 0 ? `Табу (категорически запрещено использовать): ${taboos.join(", ")}` : "";

  const fewShotClause =
    examples.length > 0
      ? `Примеры лучших постов канала (ориентируйся на их тон и структуру):\n\n${examples
          .map((ex, i) => `Пример ${i + 1}:\n${ex.text}`)
          .join("\n\n---\n\n")}`
      : "";

  const systemPrompt = `Ты редактор Telegram-канала. Напиши пост для канала на русском языке на основе FactSheet.

Стиль и правила канала:
${styleGuide}

${tabooClause}

Целевая длина поста: около ${targetLength} символов.
Обязательное требование: пост ОБЯЗАН содержать ссылку на первоисточник (${options.factSheet.primary_url}).
Не выдумывай факты и цифры, которых нет в FactSheet.

${options.format.promptTemplate ? `Специфичные инструкции формата:
${options.format.promptTemplate}` : ""}

${fewShotClause}

Верни готовый текст поста для Telegram (без обрамляющих кавычек, без JSON, чистый текст).`;

  const userContent = `FactSheet события:
Что произошло: ${options.factSheet.what_happened}
Кто: ${options.factSheet.who.join(", ")}
Числа/факты: ${JSON.stringify(options.factSheet.numbers)}
Почему это важно: ${options.factSheet.why_it_matters ?? "Не указано"}
Ключевая цитата: ${options.factSheet.key_quote ?? "Нет"}
Ссылка на первоисточник: ${options.factSheet.primary_url}`;

  const response = await llm.call({
    role,
    stage: role === "strong" ? "strong_draft" : "draft",
    channelId: options.channelId ?? null,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userContent },
    ],
    temperature: 0.4,
  });

  let text = response.raw.trim();

  // Проверка наличия ссылки на первоисточник
  if (!text.includes(options.factSheet.primary_url)) {
    text = `${text}\n\n🔗 ${options.factSheet.primary_url}`;
  }

  // Обрезка по Telegram лимиту 4096 символов
  if (text.length > TELEGRAM_MESSAGE_LIMIT) {
    const url = options.factSheet.primary_url;
    const maxBody = TELEGRAM_MESSAGE_LIMIT - url.length - 10;
    text = `${text.slice(0, maxBody)}…\n\n${url}`;
  }

  const inserted = await db
    .insertInto("drafts")
    .values({
      candidate_id: options.candidateId,
      fact_sheet_id: options.factSheetId,
      variant_n: variantN,
      model: response.model,
      profile_version: options.profile.version ?? 1,
      format_id: options.format.id ?? null,
      text,
      lang: "ru",
      cost_usd: response.costUsd as never,
    })
    .returning("id")
    .executeTakeFirstOrThrow();

  return {
    id: inserted.id,
    text,
    variantN,
    model: response.model,
    costUsd: response.costUsd,
  };
}
