import { cosineSimilarity } from "./clustering.js";

export interface MmrWeights {
  wRelevance: number;
  wNovelty: number;
  wImportance: number;
  wFreshness: number;
  wTrust: number;
  wDiversityPenalty: number;
}

export const DEFAULT_MMR_WEIGHTS: MmrWeights = {
  wRelevance: 0.30,
  wNovelty: 0.20,
  wImportance: 0.20,
  wFreshness: 0.15,
  wTrust: 0.15,
  wDiversityPenalty: 0.25,
};

export interface MmrCandidateInput {
  id: string;
  storyId: string;
  title: string;
  snippet: string;
  embedding?: number[] | null;
  relevance: number;
  novelty: number;
  importance: number;
  freshness: number;
  trust: number;
  triageReason?: string;
}

export interface MmrSelectedCandidate extends MmrCandidateInput {
  scoreTotal: number;
  scoreComponents: {
    relevance: number;
    novelty: number;
    importance: number;
    freshness: number;
    trust: number;
    diversityPenalty: number;
    weights: MmrWeights;
  };
}

/**
 * MMR-диверсификация и итоговый скоринг (спека §6.4, M2).
 * score_total = Σwi·компоненты − w6·diversity_penalty
 * Сдвигает дублирующиеся по смыслу материалы вниз, отбирает top-N (dailyCap).
 */
export function selectDiversifiedCandidates(
  candidates: MmrCandidateInput[],
  weights: MmrWeights = DEFAULT_MMR_WEIGHTS,
  dailyCap: number = 5,
): MmrSelectedCandidate[] {
  if (candidates.length === 0 || dailyCap <= 0) return [];

  const remaining = [...candidates];
  const selected: MmrSelectedCandidate[] = [];

  while (selected.length < dailyCap && remaining.length > 0) {
    let bestIndex = -1;
    let bestScore = -Infinity;
    let bestPenalty = 0;

    for (let i = 0; i < remaining.length; i++) {
      const cand = remaining[i]!;

      // Штраф за близость к уже отобранным (MMR penalty)
      let maxSim = 0;
      if (selected.length > 0 && cand.embedding) {
        for (const sel of selected) {
          if (sel.embedding) {
            const sim = Math.max(0, cosineSimilarity(cand.embedding, sel.embedding));
            if (sim > maxSim) maxSim = sim;
          }
        }
      }

      const diversityPenalty = Number((maxSim * weights.wDiversityPenalty).toFixed(4));

      const baseScore =
        weights.wRelevance * cand.relevance +
        weights.wNovelty * cand.novelty +
        weights.wImportance * cand.importance +
        weights.wFreshness * cand.freshness +
        weights.wTrust * cand.trust;

      const finalScore = Number((baseScore - diversityPenalty).toFixed(4));

      if (finalScore > bestScore) {
        bestScore = finalScore;
        bestIndex = i;
        bestPenalty = diversityPenalty;
      }
    }

    if (bestIndex === -1) break;

    const chosen = remaining.splice(bestIndex, 1)[0]!;
    selected.push({
      ...chosen,
      scoreTotal: bestScore,
      scoreComponents: {
        relevance: chosen.relevance,
        novelty: chosen.novelty,
        importance: chosen.importance,
        freshness: chosen.freshness,
        trust: chosen.trust,
        diversityPenalty: bestPenalty,
        weights,
      },
    });
  }

  return selected;
}
