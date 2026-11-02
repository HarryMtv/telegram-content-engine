import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  createSearchProvider,
  TavilySearchProvider,
  BraveSearchProvider,
  MockSearchProvider,
} from '../../src/search/index.js';
import { webSearch } from '../../src/agents/tools/index.js';

describe('Search Providers & Factory (M4, §11)', () => {
  it('creates TavilySearchProvider by default', () => {
    const provider = createSearchProvider({ apiKey: 'test-key' });
    expect(provider).toBeInstanceOf(TavilySearchProvider);
  });

  it('creates BraveSearchProvider when requested', () => {
    const provider = createSearchProvider({ provider: 'brave', apiKey: 'test-key' });
    expect(provider).toBeInstanceOf(BraveSearchProvider);
  });

  it('creates MockSearchProvider when requested', () => {
    const provider = createSearchProvider({ provider: 'mock' });
    expect(provider).toBeInstanceOf(MockSearchProvider);
  });

  it('returns undefined without an API key so web_search is not offered to agents', () => {
    expect(createSearchProvider({ provider: 'tavily' })).toBeUndefined();
    expect(createSearchProvider({ provider: 'brave', apiKey: '' })).toBeUndefined();
    // mock не требует ключа: он для тестов и локальной разработки
    expect(createSearchProvider({ provider: 'mock' })).toBeInstanceOf(MockSearchProvider);
  });

  it('MockSearchProvider returns configured mock results', async () => {
    const mock = new MockSearchProvider([
      { title: 'Item 1', url: 'https://example.com/1', snippet: 'Snippet 1' },
      { title: 'Item 2', url: 'https://example.com/2', snippet: 'Snippet 2' },
    ]);

    const results = await mock.search('query', 1);
    expect(results).toHaveLength(1);
    expect(results[0]?.title).toBe('Item 1');
  });

  it('webSearch tool executes search through search provider', async () => {
    const mock = new MockSearchProvider([
      { title: 'AI Framework', url: 'https://github.com/ai/framework', snippet: 'New LLM engine' },
    ]);

    const res = await webSearch(mock, { query: 'AI Framework', limit: 5 });
    expect(res).toHaveLength(1);
    expect(res[0]?.url).toBe('https://github.com/ai/framework');
  });
});

describe('TavilySearchProvider HTTP API', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    global.fetch = vi.fn();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('makes POST request to Tavily endpoint and parses results', async () => {
    vi.mocked(global.fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        results: [
          {
            title: 'Tavily Result',
            url: 'https://tavily.com/docs',
            content: 'Search API for LLMs',
            score: 0.98,
          },
        ],
      }),
    } as Response);

    const provider = new TavilySearchProvider({ apiKey: 'tvly-secret' });
    const results = await provider.search('test query', 3);

    expect(global.fetch).toHaveBeenCalledWith('https://api.tavily.com/search', expect.objectContaining({
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: 'tvly-secret',
        query: 'test query',
        search_depth: 'basic',
        max_results: 3,
        include_answer: false,
        include_raw_content: false,
      }),
    }));

    expect(results).toHaveLength(1);
    expect(results[0]?.title).toBe('Tavily Result');
    expect(results[0]?.url).toBe('https://tavily.com/docs');
    expect(results[0]?.snippet).toBe('Search API for LLMs');
  });

  it('returns empty array when Tavily API key is missing or request fails', async () => {
    const providerWithoutKey = new TavilySearchProvider({ apiKey: '' });
    const noKeyResults = await providerWithoutKey.search('test');
    expect(noKeyResults).toEqual([]);

    vi.mocked(global.fetch).mockResolvedValueOnce({
      ok: false,
      status: 401,
      text: async () => 'Unauthorized',
    } as Response);

    const failingProvider = new TavilySearchProvider({ apiKey: 'invalid-key' });
    const failedResults = await failingProvider.search('test');
    expect(failedResults).toEqual([]);
  });
});
