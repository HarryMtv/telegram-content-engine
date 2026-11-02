export interface EmbeddingProvider {
  readonly dimensions: number;
  embed(texts: string[]): Promise<number[][]>;
}

export interface EmbeddingConfig {
  apiKey?: string | undefined;
  model?: string | undefined;
  baseUrl?: string | undefined;
  dimensions?: number | undefined;
}
