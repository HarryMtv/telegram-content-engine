import { describe, expect, it } from "vitest";
import { selectDiversifiedCandidates, DEFAULT_MMR_WEIGHTS } from "../../src/pipeline/mmr.js";

describe("MMR Diversification & Final Scoring (Task 2.7)", () => {
  it("рассчитывает score_total со всеми компонентами и весами в scoreComponents", () => {
    const candidates = [
      {
        id: "c1",
        storyId: "s1",
        title: "News 1",
        snippet: "Text 1",
        embedding: [1, 0, 0],
        relevance: 0.9,
        novelty: 0.8,
        importance: 0.7,
        freshness: 0.95,
        trust: 0.85,
      },
    ];

    const result = selectDiversifiedCandidates(candidates, DEFAULT_MMR_WEIGHTS, 5);
    expect(result).toHaveLength(1);
    expect(result[0]!.scoreTotal).toBeGreaterThan(0.7);
    expect(result[0]!.scoreComponents.diversityPenalty).toBe(0);
    expect(result[0]!.scoreComponents.relevance).toBe(0.9);
    expect(result[0]!.scoreComponents.weights).toEqual(DEFAULT_MMR_WEIGHTS);
  });

  it("MMR сдвигает смысловые клоны вниз, отдавая приоритет разнообразию", () => {
    // c1 - топовый материал
    // c2 - почти точный клон c1 (sim ~ 1.0) с чуть меньшим скором
    // c3 - другая тема (ортогональный вектор, sim ~ 0), но с чуть меньшим базовым скором, чем c2
    const c1 = {
      id: "c1",
      storyId: "s1",
      title: "OpenAI launches GPT-5",
      snippet: "Model release",
      embedding: [1, 0, 0],
      relevance: 0.95,
      novelty: 0.9,
      importance: 0.9,
      freshness: 0.9,
      trust: 0.9,
    };
    const c2Clone = {
      id: "c2-clone",
      storyId: "s2",
      title: "GPT-5 release announced today",
      snippet: "Details on GPT-5",
      embedding: [0.99, 0.01, 0], // Клон c1!
      relevance: 0.92,
      novelty: 0.88,
      importance: 0.88,
      freshness: 0.88,
      trust: 0.88,
    };
    const c3Different = {
      id: "c3-different",
      storyId: "s3",
      title: "New Rust Compiler Feature",
      snippet: "Rust 1.90 details",
      embedding: [0, 1, 0], // Полностью другая тема
      relevance: 0.80,
      novelty: 0.80,
      importance: 0.75,
      freshness: 0.85,
      trust: 0.85,
    };

    const result = selectDiversifiedCandidates([c1, c2Clone, c3Different], DEFAULT_MMR_WEIGHTS, 2);

    expect(result).toHaveLength(2);
    expect(result[0]!.id).toBe("c1");
    // Второй выбранный — c3Different, а не c2Clone (потому что c2Clone получил diversityPenalty ~0.25)
    expect(result[1]!.id).toBe("c3-different");
    expect(result[1]!.scoreComponents.diversityPenalty).toBe(0);
  });

  it("жёстко соблюдает дневной потолок (dailyCap = 5)", () => {
    const manyCandidates = Array.from({ length: 20 }, (_, i) => ({
      id: `cand-${i}`,
      storyId: `story-${i}`,
      title: `Title ${i}`,
      snippet: `Snippet ${i}`,
      embedding: [Math.cos(i), Math.sin(i), 0],
      relevance: 0.8,
      novelty: 0.8,
      importance: 0.8,
      freshness: 0.8,
      trust: 0.8,
    }));

    const result = selectDiversifiedCandidates(manyCandidates, DEFAULT_MMR_WEIGHTS, 5);
    expect(result).toHaveLength(5);
  });
});
