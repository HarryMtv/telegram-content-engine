import type { SearchProvider, SearchResultItem } from './types.js';

/**
 * Mock провайдер веб-поиска для тестов и локальной разработки без API-ключей.
 */
export class MockSearchProvider implements SearchProvider {
  constructor(private mockResults: SearchResultItem[] = []) {}

  setResults(results: SearchResultItem[]): void {
    this.mockResults = results;
  }

  async search(_query: string, limit = 5): Promise<SearchResultItem[]> {
    return this.mockResults.slice(0, limit);
  }
}
