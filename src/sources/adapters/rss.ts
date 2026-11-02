import Parser from 'rss-parser';
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

/** Первый опрос не должен заливать всю историю ленты. */
const FIRST_POLL_LIMIT = 20;

interface RssEntry {
  guid?: string;
  link?: string;
  title?: string;
  isoDate?: string;
  pubDate?: string;
  creator?: string;
  contentSnippet?: string;
}

const parser = new Parser<RssEntry, Record<string, unknown>>();

/** Адаптер RSS: блогов лабораторий и медиа (спека §5.2). */
export const rssAdapter: SourceAdapter = {
  type: 'rss',
  adapter: 'rss',

  async discover(ctx: AdapterContext): Promise<DiscoverResult> {
    const feedUrl = ctx.config.url;
    if (!feedUrl) throw new Error('rss-адаптер требует config.url');
    // фетчим ленту сами: единый таймаут/UA и инъекция для тестов
    const res = await (ctx.fetchLike ?? fetch)(feedUrl, {
      headers: { 'user-agent': 'TelegramContentEngine/0.1 (+rss)' },
      signal: AbortSignal.timeout(15_000),
      redirect: 'follow',
    });
    if (!res.ok) throw new Error(`RSS ${feedUrl}: HTTP ${res.status}`);
    const feed = await parser.parseString(await res.text());

    const lastTs = typeof ctx.cursor?.lastTs === 'string' ? new Date(ctx.cursor.lastTs) : null;
    const entries = [...feed.items].sort(
      (a, b) => entryDate(b).getTime() - entryDate(a).getTime(),
    );

    const refs = [];
    let newestTs = lastTs;
    for (const entry of entries) {
      if (!entry.link || !entry.title) continue;
      const ts = entryDate(entry);
      if (Number.isNaN(ts.getTime())) continue;
      if (lastTs && ts <= lastTs) continue;
      // фиксируем водяную метку только по реально взятым записям
      newestTs = !newestTs || ts > newestTs ? ts : newestTs;
      refs.push(
        ItemRef.parse({
          externalId: entry.guid ?? entry.link,
          url: entry.link,
          title: entry.title,
          publishedAt: ts,
          snippet: entry.contentSnippet,
        }),
      );
      if (!lastTs && refs.length >= FIRST_POLL_LIMIT) break; // первый опрос
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

function entryDate(entry: RssEntry): Date {
  return new Date(entry.isoDate ?? entry.pubDate ?? Date.now());
}
