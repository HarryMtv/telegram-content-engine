import { extractArticle } from '../extract.js';
import { canonicalizeWithRedirects, type FetchLike } from '../../pipeline/canonicalize-url.js';
import type {
  AdapterContext,
  DiscoverResult,
  FetchedContent,
  FetchTarget,
  SourceAdapter,
} from '../types.js';
import { ItemRef } from '../../domain/schemas.js';

const FRONT_PAGE_URL = 'https://hn.algolia.com/api/v1/search?tags=front_page&hitsPerPage=50';
const DEFAULT_POINTS_THRESHOLD = 50;

interface HnHit {
  objectID: string;
  title?: string;
  url?: string;
  points?: number;
  created_at?: string;
  author?: string;
}

/** Адаптер HN front page через Algolia API (спека §5.2), порог по очкам. */
export const hnAlgoliaAdapter: SourceAdapter = {
  type: 'api',
  adapter: 'hn_algolia',

  async discover(ctx: AdapterContext): Promise<DiscoverResult> {
    const res = await (ctx.fetchLike ?? fetch)(FRONT_PAGE_URL, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`HN Algolia HTTP ${res.status}`);
    const data = (await res.json()) as { hits?: HnHit[] };
    const threshold = ctx.config.threshold ?? DEFAULT_POINTS_THRESHOLD;

    const lastTs = typeof ctx.cursor?.lastTs === 'string' ? new Date(ctx.cursor.lastTs) : null;
    const refs = [];
    let newestTs = lastTs;
    for (const hit of data.hits ?? []) {
      if (!hit.url || !hit.title || !hit.created_at) continue; // Ask HN и прочее без ссылки
      if ((hit.points ?? 0) < threshold) continue;
      const ts = new Date(hit.created_at);
      if (lastTs && ts <= lastTs) continue;
      newestTs = !newestTs || ts > newestTs ? ts : newestTs;
      refs.push(
        ItemRef.parse({
          externalId: hit.objectID,
          url: hit.url,
          title: hit.title,
          publishedAt: ts,
          externalSignals: { hn_points: hit.points ?? 0 },
        }),
      );
    }

    return {
      refs,
      cursor: newestTs ? { lastTs: newestTs.toISOString() } : (ctx.cursor ?? {}),
    };
  },

  async fetch(target: FetchTarget, fetchLike: FetchLike = fetch): Promise<FetchedContent> {
    const canonical = await canonicalizeWithRedirects(target.url, fetchLike);
    const bodyText = await extractArticle(canonical, fetchLike);
    return { bodyText };
  },
};
