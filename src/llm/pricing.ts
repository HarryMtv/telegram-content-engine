import type { ModelPricing } from "./types.js";

/**
 * Расчёт стоимости LLM-вызова в USD.
 * Цены задаются в долларах за 1 миллион токенов.
 */
export function calculateCallCost(
  inputTokens: number,
  outputTokens: number,
  pricing: ModelPricing,
): number {
  const inputCost = (inputTokens / 1_000_000) * pricing.inputPricePerMillion;
  const outputCost = (outputTokens / 1_000_000) * pricing.outputPricePerMillion;
  return Number((inputCost + outputCost).toFixed(6));
}

export const DEFAULT_LLM_CONFIG = {
  monthlyBudgetUsd: 10,
  models: {
    cheap: {
      model: "gpt-4o-mini",
      inputPricePerMillion: 0.15,
      outputPricePerMillion: 0.6,
    },
    strong: {
      model: "gpt-4o",
      inputPricePerMillion: 2.5,
      outputPricePerMillion: 10.0,
    },
  },
};
