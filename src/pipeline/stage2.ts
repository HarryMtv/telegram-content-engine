import { z } from "zod";
import type { LlmClient } from "../llm/client.js";

export const TriageItemSchema = z.object({
  id: z.string(),
  relevance: z.number().min(0).max(1),
  novelty: z.number().min(0).max(1),
  reason: z.string(),
});

export const TriageBatchResponseSchema = z.object({
  evaluations: z.array(TriageItemSchema),
});

export type TriageEvaluation = z.infer<typeof TriageItemSchema>;

export interface Stage2CandidateInput {
  id: string; // itemId или candidateId
  title: string;
  snippet: string;
  storyId?: string;
  sourceTrust?: number;
  scoreStage1?: number;
}

export interface Stage2TriageResult extends Stage2CandidateInput {
  tlevanceScore: number;
  noveltyScore: number;
  triageReason: string;
}

/**
 * Стадия 2 — LLM-триаж (спека §6.4).
 * Батч дешёвой моделью оценивает материалы против правил отбора (selection_rules).
 */
export async function runStage2Triage(
  llm: LlmClient,
  candidates: Stage2CandidateInput[],
  selectionRules: string,
  options: {
    channelId?: string;
    maxOutput?: number; // по умолчанию 8
  } = {},
): Promise<Stage2TriageResult[]> {
  if (candidates.length === 0) return [];

  const maxOutput = options.maxOutput ?? 8;

  const itemsDescription = candidates
    .map(
      (c, idx) =>
        `[${idx + 1}] ID: ${c.id}\nЗаголовок: ${c.title}\nТекст/выжимка: ${c.snippet.slice(0, 300)}`,
    )
    .join("\n\n");

  const systemPrompt = `Ты редактор контентного канала. Оцени каждый материал на соответствие правилам отбора.
Правила отбора канала:
${selectionRules || "Технологические новости, наука, AI, инженерные решения. Без рекламы и спама."}

Для каждого материала верни:
- id: строковый ID материала
- relevance: число от 0.0 до 1.0 (насколько подходит тематике и правилам)
- novelty: число от 0.0 до 1.0 (насколько новость свежая и не банальная)
- reason: краткая причина на русском (1-2 предложения), почему материал подходит или нет

Ответь строго JSON-объектом формата {"evaluations": [{"id": "...", "relevance": 0.9, "novelty": 0.8, "reason": "..."}]}`;

  const response = await llm.call({
    role: "cheap",
    stage: "triage",
    channelId: options.channelId ?? null,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: `Оцени следующие ${candidates.length} материалов:\n\n${itemsDescription}` },
    ],
    schema: TriageBatchResponseSchema,
    temperature: 0.1,
  });

  const evalMap = new Map<string, TriageEvaluation>();
  for (const ev of response.data.evaluations) {
    evalMap.set(ev.id, ev);
  }

  const evaluated: Stage2TriageResult[] = candidates.map((c) => {
    const ev = evalMap.get(c.id);
    return {
      ...c,
      tlevanceScore: ev?.relevance ?? 0.5,
      noveltyScore: ev?.novelty ?? 0.5,
      triageReason: ev?.reason ?? "Оценка по умолчанию",
    };
  });

  // Сортировка по (relevance * 0.6 + novelty * 0.4) и ограничение лимитом 5-8
  return evaluated
    .sort((a, b) => b.tlevanceScore * 0.6 + b.noveltyScore * 0.4 - (a.tlevanceScore * 0.6 + a.noveltyScore * 0.4))
    .slice(0, maxOutput);
}
