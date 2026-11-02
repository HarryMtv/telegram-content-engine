import type { SearchProvider, SearchResultItem } from './types.js';

export interface BraveSearchOptions {
  apiKey: string;
  baseUrl?: string | undefined;
}

/**
 * Провайдер веб-поиска через Brave Search API.
 */
export class BraveSearchProvider implements SearchProvider {
  private apiKey: string;
  private baseUrl: string;

  constructor(opts: BraveSearchOptions) {
    this.apiKey = opts.apiKey;
    this.baseUrl = opts.baseUrl || 'https://api.search.brave.com/res/v1/web/search';
  }

  async search(query: string, limit = 5): Promise<SearchResultItem[]> {
    if (!this.apiKey) {
      console.warn('[Brave] BRAVE_SEARCH_API_KEY не задан — веб-поиск не может выполнить запрос');
      return [];
    }

    try {
      const url = new URL(this.baseUrl);
      url.searchParams.set('q', query);
      url.searchParams.set('count', String(Math.min(limit, 20)));

      const response = await fetch(url.toString(), {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          'Accept-Encoding': 'gzip',
          'X-Subscription-Token': this.apiKey,
        },
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error(`[Brave] Ошибка поиска (${response.status}): ${errorText}`);
        return [];
      }

      const data = (await response.json()) as {
        web?: {
          results?: Array<{
            title?: string;
            url?: string;
            description?: string;
          }>;
        };
      };

      const results = data.web?.results || [];
      return results.map((r) => ({
        title: r.title || '',
        url: r.url || '',
        snippet: r.description || '',
      }));
    } catch (err) {
      console.error('[Brave] Ошибка при обращении к API:', err instanceof Error ? err.message : String(err));
      return [];
    }
  }
}
