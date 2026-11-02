import type { SearchProvider } from './types.js';
import { TavilySearchProvider } from './tavily.js';
import { BraveSearchProvider } from './brave.js';
import { MockSearchProvider } from './mock.js';

export interface SearchConfig {
  provider?: 'tavily' | 'brave' | 'mock' | undefined;
  apiKey?: string | undefined;
  baseUrl?: string | undefined;
}

/**
 * Провайдер веб-поиска для агентов (спека §11, agents/spec.md «Web Search Tool»).
 * Без ключа возвращает undefined: инструмент web_search тогда вообще не попадает
 * в набор агента, вместо того чтобы жечь шаг на заведомо пустой ответ.
 */
export function createSearchProvider(config: SearchConfig): SearchProvider | undefined {
  const provider = config.provider || 'tavily';

  if (provider === 'mock') {
    return new MockSearchProvider();
  }

  if (!config.apiKey) return undefined;

  if (provider === 'brave') {
    return new BraveSearchProvider({
      apiKey: config.apiKey,
      baseUrl: config.baseUrl,
    });
  }

  return new TavilySearchProvider({
    apiKey: config.apiKey,
    baseUrl: config.baseUrl,
  });
}
