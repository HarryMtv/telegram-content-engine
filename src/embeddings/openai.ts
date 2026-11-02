import type { EmbeddingProvider, EmbeddingConfig } from "./types.js";

export class HttpOpenAiEmbeddingProvider implements EmbeddingProvider {
  public readonly dimensions: number;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly baseUrl: string;

  constructor(config: EmbeddingConfig) {
    if (!config.apiKey) {
      throw new Error("API ключ обязателен для OpenAI Embedding провайдера");
    }
    this.apiKey = config.apiKey;
    this.model = config.model ?? "text-embedding-3-small";
    this.baseUrl = (config.baseUrl ?? "https://api.openai.com/v1").replace(/\/+$/, "");
    this.dimensions = config.dimensions ?? 1024;
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];

    const url = `${this.baseUrl}/embeddings`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        input: texts.map((t) => t.slice(0, 8000)),
        dimensions: this.dimensions,
      }),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      throw new Error(`OpenAI Embed HTTP ${res.status}: ${errText.slice(0, 300)}`);
    }

    const data = (await res.json()) as {
      data: Array<{ embedding: number[]; index: number }>;
    };

    return data.data.sort((a, b) => a.index - b.index).map((d) => d.embedding);
  }
}
