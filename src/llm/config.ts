import type { ModelPricing, ModelRole, LlmConfig } from "./types.js";

export type KnownLlmProvider =
  | "openai"
  | "openrouter"
  | "deepseek"
  | "groq"
  | "mock"
  | "custom";

export interface ProviderPreset {
  baseUrl: string;
  defaultModel: string;
  pricing: ModelPricing;
}

export const KNOWN_MODELS: Record<string, ModelPricing> = {
  // OpenAI
  "gpt-4o-mini": { model: "gpt-4o-mini", inputPricePerMillion: 0.15, outputPricePerMillion: 0.60 },
  "gpt-4o": { model: "gpt-4o", inputPricePerMillion: 2.50, outputPricePerMillion: 10.00 },
  "o3-mini": { model: "o3-mini", inputPricePerMillion: 1.10, outputPricePerMillion: 4.40 },

  // DeepSeek
  "deepseek-chat": { model: "deepseek-chat", inputPricePerMillion: 0.14, outputPricePerMillion: 0.28 },
  "deepseek-reasoner": { model: "deepseek-reasoner", inputPricePerMillion: 0.55, outputPricePerMillion: 2.19 },
  "deepseek-v4-flash": { model: "deepseek-v4-flash", inputPricePerMillion: 0.10, outputPricePerMillion: 0.20 },

  // OpenRouter (aliases)
  "openai/gpt-4o-mini": { model: "openai/gpt-4o-mini", inputPricePerMillion: 0.15, outputPricePerMillion: 0.60 },
  "openai/gpt-4o": { model: "openai/gpt-4o", inputPricePerMillion: 2.50, outputPricePerMillion: 10.00 },
  "nvidia/nemotron-3-ultra-550b-a55b:free": { model: "nvidia/nemotron-3-ultra-550b-a55b:free", inputPricePerMillion: 0.00, outputPricePerMillion: 0.00 },
  "anthropic/claude-3.5-haiku": { model: "anthropic/claude-3.5-haiku", inputPricePerMillion: 0.80, outputPricePerMillion: 4.00 },
  "anthropic/claude-3.5-sonnet": { model: "anthropic/claude-3.5-sonnet", inputPricePerMillion: 3.00, outputPricePerMillion: 15.00 },
  "deepseek/deepseek-chat": { model: "deepseek/deepseek-chat", inputPricePerMillion: 0.14, outputPricePerMillion: 0.28 },
  "meta-llama/llama-3.3-70b-instruct": { model: "meta-llama/llama-3.3-70b-instruct", inputPricePerMillion: 0.35, outputPricePerMillion: 0.40 },

  // Groq
  "llama-3.3-70b-versatile": { model: "llama-3.3-70b-versatile", inputPricePerMillion: 0.59, outputPricePerMillion: 0.79 },
  "mixtral-8x7b-32768": { model: "mixtral-8x7b-32768", inputPricePerMillion: 0.24, outputPricePerMillion: 0.24 },
};

export const PROVIDER_BASE_URLS: Record<KnownLlmProvider, string> = {
  openai: "https://api.openai.com/v1",
  openrouter: "https://openrouter.ai/api/v1",
  deepseek: "https://api.deepseek.com/v1",
  groq: "https://api.groq.com/openai/v1",
  mock: "",
  custom: "https://api.openai.com/v1",
};

export interface RoleConfigInput {
  provider?: (KnownLlmProvider | string) | undefined;
  model?: string | undefined;
  baseUrl?: string | undefined;
  apiKey?: string | undefined;
  inputPricePerMillion?: number | undefined;
  outputPricePerMillion?: number | undefined;
}

export function resolveRoleConfig(
  role: ModelRole,
  input?: RoleConfigInput,
  fallbackApiKey?: string,
): {
  provider: string;
  model: string;
  baseUrl: string;
  apiKey: string;
  pricing: ModelPricing;
} {
  const provider = (input?.provider || "openai").toLowerCase();
  const defaultModel = role === "cheap" ? "gpt-4o-mini" : "gpt-4o";
  const model = input?.model || defaultModel;

  const defaultBaseUrl = PROVIDER_BASE_URLS[provider as KnownLlmProvider] || PROVIDER_BASE_URLS.openai;
  const baseUrl = input?.baseUrl || defaultBaseUrl;
  const apiKey = input?.apiKey || fallbackApiKey || "";

  const known = KNOWN_MODELS[model];
  const inputPrice = input?.inputPricePerMillion ?? known?.inputPricePerMillion ?? (role === "cheap" ? 0.15 : 2.50);
  const outputPrice = input?.outputPricePerMillion ?? known?.outputPricePerMillion ?? (role === "cheap" ? 0.60 : 10.00);

  return {
    provider,
    model,
    baseUrl,
    apiKey,
    pricing: {
      model,
      inputPricePerMillion: inputPrice,
      outputPricePerMillion: outputPrice,
    },
  };
}
