import type { EmbeddingProvider, EmbeddingConfig } from "./types.js";

export class HttpCohereEmbeddingProvider implements EmbeddingProvider {
  public readonly dimensions: number = 1024;
  private readonly apiKey: string;
  private readonly model: string;

  constructor(config: EmbeddingConfig) {
    if (!config.apiKey) {
      throw new Error("COHERE_API_KEY / EMBEDDINGS_API_KEY обязателен для Cohere провайдера");
    }
    this.apiKey = config.apiKey;
    this.model = config.model ?? "embed-multilingual-v3.0";
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];

    const res = await fetch("https://api.cohere.com/v1/embed", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        texts: texts.map((t) => t.slice(0, 4000)),
        input_type: "search_document",
        truncate: "END",
      }),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      throw new Error(`Cohere Embed HTTP ${res.status}: ${errText.slice(0, 300)}`);
    }

    const data = (await res.json()) as { embeddings: number[][] };
    return data.embeddings;
  }
}
