import { z } from "zod";

export type ModelRole = "cheap" | "strong";

export type LlmStage =
  | "triage"
  | "factsheet"
  | "fact_check"
  | "draft"
  | "strong_draft"
  | "analyst"
  | "resolver"
  | "scout";

export interface ModelPricing {
  model: string;
  inputPricePerMillion: number;
  outputPricePerMillion: number;
}

export interface LlmConfig {
  apiKey?: string;
  baseUrl?: string;
  monthlyBudgetUsd: number;
  models: {
    cheap: ModelPricing;
    strong: ModelPricing;
  };
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface LlmCallOptions<T = unknown> {
  role: ModelRole;
  stage: LlmStage;
  channelId?: string | null | undefined;
  messages: ChatMessage[];
  schema?: z.ZodType<T>;
  temperature?: number;
  maxTokens?: number;
}

export interface LlmCallResult<T = unknown> {
  id: string;
  raw: string;
  data: T;
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  latencyMs: number;
}

export interface ProviderResponse {
  text: string;
  inputTokens: number;
  outputTokens: number;
}

export interface LlmProvider {
  chat(options: {
    model: string;
    messages: ChatMessage[];
    temperature?: number;
    maxTokens?: number;
    jsonMode?: boolean;
  }): Promise<ProviderResponse>;
}
