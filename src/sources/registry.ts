import type { SourceAdapter } from './types.js';
import { rssAdapter } from './adapters/rss.js';
import { hnAlgoliaAdapter } from './adapters/hn-algolia.js';
import { redditJsonAdapter } from './adapters/reddit-json.js';
import { hfDailyPapersAdapter } from './adapters/hf-daily-papers.js';
import { githubTrendingAdapter } from './adapters/github-trending.js';
import { telegramAdapter } from './adapters/telegram.js';
import { manualAdapter } from './adapters/manual.js';

/** Реестр адаптеров по полю sources.adapter (M1-M5). */
const adapters: Map<string, SourceAdapter> = new Map(
  [
    rssAdapter,
    hnAlgoliaAdapter,
    redditJsonAdapter,
    hfDailyPapersAdapter,
    githubTrendingAdapter,
    telegramAdapter,
    manualAdapter,
  ].map((a) => [a.adapter, a]),
);

export function getAdapter(name: string): SourceAdapter {
  const adapter = adapters.get(name);
  if (!adapter) throw new Error(`Неизвестный адаптер источника: ${name}`);
  return adapter;
}

export function listAdapters(): string[] {
  return [...adapters.keys()];
}
