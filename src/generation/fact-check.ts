import { z } from "zod";
import type { Kysely } from "kysely";
import type { Database } from "../db/types.js";
import type { LlmClient } from "../llm/client.js";
import { type FactSheetData, type StoryItemInput } from "./factsheet.js";

export const FactCheckResultSchema = z.object({
  passed: z.boolean(),
  confidence: z.number().min(0).max(1),
  discrepancies: z.array(z.string()).default([]),
  notes: z.string().optional(),
});

export interface FactCheckResult {
  passed: boolean;
  confidence: number;
  discrepancies: string[];
  notes?: string;
}

export async function verifyFactSheet(
  llm: LlmClient,
  db: Kysely<Database>,
  factSheetId: string,
  factSheet: FactSheetData,
  sources: StoryItemInput[],
  options: { channelId?: string } = {},
): Promise<{ factSheet: FactSheetData; check: FactCheckResult }> {
  const originalTexts = sources
    .map((s, idx) => `[Источник ${idx + 1}] ${s.title}\n${s.bodyText.slice(0, 3000)}`)
    .join("\n\n---\n\n");

  const systemPrompt = `Ты фактчекер. Твоя задача — строго сверить FactSheet с исходным текстом материалов.
Проверь:
1. Соответствуют ли числа, метрики и факты из FactSheet оригиналам?
2. Нет ли искажений, выдуманных данных или галлюцинаций?
3. Верны ли цитаты и персоны?

Верни результат строго в формате JSON:
- passed: boolean (true, если все факты и цифры подтверждены оригиналами)
- confidence: число от 0.0 до 1.0 (1.0 - полная уверенность, <0.8 - есть расхождения)
- discrepancies: массив строк с описанием найденных искажений или неточностей
- notes: краткий комментарий проверки`;

  const response = await llm.call({
    role: "cheap",
    stage: "fact_check",
    channelId: options.channelId ?? null,
    messages: [
      { role: "system", content: systemPrompt },
      {
        role: "user",
        content: `Сверь FactSheet:\n${JSON.stringify(factSheet, null, 2)}\n\nС оригинальными текстами:\n${originalTexts}`,
      },
    ],
    schema: FactCheckResultSchema,
    temperature: 0.0,
  });

  const checkData = response.data;
  const check: FactCheckResult = {
    passed: checkData.passed,
    confidence: checkData.confidence,
    discrepancies: checkData.discrepancies || [],
    ...(checkData.notes ? { notes: checkData.notes } : {}),
  };

  const updatedConfidence = check.passed
    ? Math.min(factSheet.confidence, check.confidence)
    : Math.min(factSheet.confidence, check.confidence, 0.6);

  const updatedFactSheet: FactSheetData = {
    ...factSheet,
    confidence: Number(updatedConfidence.toFixed(2)),
  };

  await db
    .updateTable("fact_sheets")
    .set({
      confidence: updatedFactSheet.confidence as never,
    })
    .where("id", "=", factSheetId)
    .execute();

  return { factSheet: updatedFactSheet, check };
}
