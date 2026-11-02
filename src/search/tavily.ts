import type { SearchProvider, SearchResultItem } from './types.js';

export interface TavilySearchOptions {
  apiKey: string;
  baseUrl?: string | undefined;
}

/**
 * Провайдер веб-поиска через Tavily Search API.
 * Оптимизирован для AI-агентов: возвращает очищенный текст и релевантные сниппеты.
 */
export class TavilySearchProvider implements SearchProvider {
  private apiKey: string;
  private baseUrl: string;

  constructor(opts: TavilySearchOptions) {
    this.apiKey = opts.apiKey;
    this.baseUrl = opts.baseUrl || 'https://api.tavily.com';
  }

  async search(query: string, limit = 5): Promise<SearchResultItem[]> {
    if (!this.apiKey) {
      console.warn('[Tavily] TAVILY_API_KEY не задан — веб-поиск не может выполнить запрос');
      return [];
    }

    try {
      const response = await fetch(`${this.baseUrl}/search`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          api_key: this.apiKey,
          query,
          search_depth: 'basic',
          max_results: limit,
          include_answer: false,
          include_raw_content: false,
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error(`[Tavily] Ошибка поиска (${response.status}): ${errorText}`);
        return [];
      }

      const data = (await response.json()) as {
        results?: Array<{
          title?: string;
          url?: string;
          content?: string;
          score?: number;
        }>;
      };

      if (!data.results || !Array.isArray(data.results)) {
        return [];
      }

      return data.results.map((r) => ({
        title: r.title || '',
        url: r.url || '',
        snippet: r.content || '',
        score: r.score,
      }));
    } catch (err) {
      console.error('[Tavily] Ошибка при обращении к API:', err instanceof Error ? err.message : String(err));
      return [];
    }
  }
}
