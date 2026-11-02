import type { EmbeddingProvider } from "./types.js";

export class MockEmbeddingProvider implements EmbeddingProvider {
  public callCount = 0;
  public readonly dimensions: number;

  constructor(dimensions: number = 1024) {
    this.dimensions = dimensions;
  }

  async embed(texts: string[]): Promise<number[][]> {
    this.callCount += 1;
    return texts.map((text, i) => {
      const vec = new Array(this.dimensions).fill(0);
      for (let j = 0; j < text.length && j < this.dimensions; j++) {
        vec[j] = ((text.charCodeAt(j) * (i + 1)) % 100) / 100;
      }
      const norm = Math.sqrt(vec.reduce((sum, v) => sum + v * v, 0)) || 1;
      return vec.map((v) => v / norm);
    });
  }
}
