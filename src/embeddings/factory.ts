import type { EmbeddingProvider, EmbeddingConfig } from "./types.js";
import { HttpCohereEmbeddingProvider } from "./cohere.js";
import { HttpOpenAiEmbeddingProvider } from "./openai.js";
import { MockEmbeddingProvider } from "./mock.js";

export type EmbeddingProviderType = "cohere" | "openai" | "mock" | "custom";

export interface CreateEmbeddingProviderOptions extends EmbeddingConfig {
  provider?: (EmbeddingProviderType | string) | undefined;
}

export function createEmbeddingProvider(options: CreateEmbeddingProviderOptions): EmbeddingProvider {
  const provider = options.provider ?? (options.apiKey?.startsWith("sk-") ? "openai" : "cohere");

  switch (provider) {
    case "cohere":
      return new HttpCohereEmbeddingProvider({
        apiKey: options.apiKey,
        model: options.model ?? "embed-multilingual-v3.0",
        dimensions: options.dimensions ?? 1024,
      });

    case "openai":
    case "custom":
      return new HttpOpenAiEmbeddingProvider({
        apiKey: options.apiKey,
        model: options.model ?? "text-embedding-3-small",
        baseUrl: options.baseUrl,
        dimensions: options.dimensions ?? 1024,
      });

    case "mock":
    default:
      return new MockEmbeddingProvider(options.dimensions ?? 1024);
  }
}
