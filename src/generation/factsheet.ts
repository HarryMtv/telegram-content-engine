import { z } from "zod";
import type { Kysely } from "kysely";
import type { Database } from "../db/types.js";
import type { LlmClient } from "../llm/client.js";

export const FactSheetSchema = z.object({
  what_happened: z.string().min(10, "Поле what_happened обязательно"),
  who: z.array(z.string()).default([]),
  numbers: z.record(z.unknown()).default({}),
  key_quote: z.string().nullable().optional(),
  why_it_matters: z.string().nullable().optional(),
  primary_url: z.string().url("primary_url должен быть валидным URL"),
  confidence: z.number().min(0).max(1).default(1.0),
  source_item_ids: z.array(z.string()).default([]),
});

export interface FactSheetData {
  what_happened: string;
  who: string[];
  numbers: Record<string, unknown>;
  key_quote?: string | null | undefined;
  why_it_matters?: string | null | undefined;
  primary_url: string;
  confidence: number;
  source_item_ids: string[];
}

export interface StoryItemInput {
  id: string;
  title: string;
  bodyText: string;
  canonicalUrl: string;
}

export async function generateFactSheet(
  llm: LlmClient,
  db: Kysely<Database>,
  storyId: string,
  items: StoryItemInput[],
  options: { channelId?: string } = {},
): Promise<{ id: string; factSheet: FactSheetData }> {
  if (items.length === 0) {
    throw new Error("Не переданы материалы для генерации FactSheet");
  }

  const primaryUrl = items[0]!.canonicalUrl;
  const itemIds = items.map((i) => i.id);

  const materialsText = items
    .map(
      (it, idx) =>
        `[Материал ${idx + 1}] ID: ${it.id}\nЗаголовок: ${it.title}\nСсылка: ${it.canonicalUrl}\nТекст: ${it.bodyText.slice(0, 3000)}`,
    )
    .join("\n\n---\n\n");

  const systemPrompt = `Ты аналитик фактов. Твоя задача — извлечь структурированный FactSheet из предоставленных материалов.
FactSheet должен быть нейтральным, языконезависимым и содержать:
- what_happened: точное и исчерпывающее описание сути события (2-4 предложения)
- who: массив ключевых лиц, компаний или проектов
- numbers: объект с ключевыми числами, метриками и датами (например {"price": "10B", "version": "4.5"})
- key_quote: ключевая важная цитата (если есть) или null
- why_it_matters: почему это событие важно для индустрии / читателя
- primary_url: основная ссылка на первоисточник (${primaryUrl})
- confidence: степень уверенности в фактах от 0.0 до 1.0 (по умолчанию 1.0)
- source_item_ids: массив ID использованных материалов [${itemIds.map((id) => `"${id}"`).join(", ")}]

Ответь строго JSON-объектом по указанной структуре.`;

  const response = await llm.call({
    role: "cheap",
    stage: "factsheet",
    channelId: options.channelId ?? null,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: `Извлеки FactSheet из следующих материалов:\n\n${materialsText}` },
    ],
    schema: FactSheetSchema,
    temperature: 0.1,
  });

  const parsed = response.data;
  const factSheet: FactSheetData = {
    what_happened: parsed.what_happened,
    who: parsed.who || [],
    numbers: parsed.numbers || {},
    key_quote: parsed.key_quote,
    why_it_matters: parsed.why_it_matters,
    primary_url: parsed.primary_url || primaryUrl,
    confidence: parsed.confidence ?? 1.0,
    source_item_ids: parsed.source_item_ids && parsed.source_item_ids.length > 0 ? parsed.source_item_ids : itemIds,
  };

  const inserted = await db
    .insertInto("fact_sheets")
    .values({
      story_id: storyId,
      what_happened: factSheet.what_happened,
      who: factSheet.who,
      numbers: factSheet.numbers as never,
      key_quote: factSheet.key_quote ?? null,
      why_it_matters: factSheet.why_it_matters ?? null,
      primary_url: factSheet.primary_url,
      confidence: factSheet.confidence as never,
      source_item_ids: factSheet.source_item_ids,
    })
    .returning("id")
    .executeTakeFirstOrThrow();

  return { id: inserted.id, factSheet };
}
