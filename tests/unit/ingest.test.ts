import { describe, it, expect } from 'vitest';
import { extractUrls, parseModifiers, detectPayloadType } from '../../src/ingest/parser.js';
import { processIngest } from '../../src/ingest/service.js';
import { canonicalizeUrl, urlHash } from '../../src/pipeline/canonicalize-url.js';
import type { Kysely } from 'kysely';
import type { Database } from '../../src/db/types.js';
import type { ResolverJob } from '../../src/queue/index.js';

describe('Ingest Parser (M3, §7.1-7.2)', () => {
  it('extracts multiple URLs with various punctuation', () => {
    const text = `
      Check this out: https://example.com/post/1.
      Also: https://github.com/cool/repo, and https://news.ycombinator.com/item?id=123!
    `;
    const urls = extractUrls(text);
    expect(urls).toEqual([
      'https://example.com/post/1',
      'https://github.com/cool/repo',
      'https://news.ycombinator.com/item?id=123',
    ]);
  });

  it('parses modifiers from text correctly', () => {
    const input = '/ingest https://news.com/article --channel=ai-tech --force --priority=high';
    const parsed = parseModifiers(input);
    expect(parsed.channelHint).toBe('ai-tech');
    expect(parsed.force).toBe(true);
    expect(parsed.priority).toBe('high');
    expect(parsed.cleanText).toBe('https://news.com/article');
  });

  it('parses short flags like --high', () => {
    const input = 'https://news.com/article --high';
    const parsed = parseModifiers(input);
    expect(parsed.priority).toBe('high');
    expect(parsed.cleanText).toBe('https://news.com/article');
  });

  it('detects payload types correctly', () => {
    expect(detectPayloadType({ text: 'https://example.com' }).payloadType).toBe('url');
    expect(
      detectPayloadType({
        text: 'https://example.com/1\nhttps://example.com/2',
      }).payloadType,
    ).toBe('url');
    expect(detectPayloadType({ text: 'Интересная мысль для поста', isForward: false }).payloadType).toBe('text');
    expect(detectPayloadType({ text: 'Текст поста', isForward: true }).payloadType).toBe('forward');
    expect(detectPayloadType({ text: 'url list inside', isFile: true }).payloadType).toBe('file');
  });
});

describe('Ingest Deduplication with Canonical URL Hashing (M3, §6.2)', () => {
  it('hashes canonical URL stripping tracking parameters', async () => {
    let insertedUrlHash = '';
    const rawUrl = 'https://example.com/post?utm_source=telegram&utm_medium=channel';
    const canonical = canonicalizeUrl(rawUrl);
    const expectedHash = urlHash(canonical);

    const mockDb: any = {
      selectFrom: (table: string) => {
        const queryObj: any = {
          leftJoin: () => queryObj,
          innerJoin: () => queryObj,
          select: () => queryObj,
          where: () => queryObj,
          executeTakeFirst: async () => {
            if (table === 'sources') return { id: 'source-1' };
            return null;
          },
        };
        return queryObj;
      },
      insertInto: () => ({
        values: (val: any) => {
          if (val.url_hash) insertedUrlHash = val.url_hash;
          const chain: any = {
            onConflict: () => chain,
            returning: () => chain,
            executeTakeFirstOrThrow: async () => ({ id: 'row-1' }),
          };
          return chain;
        },
      }),
    };

    const res = await processIngest(mockDb, {
      urls: [rawUrl],
      submittedBy: 12345,
      role: 'owner',
    });

    expect(res.success).toBe(true);
    expect(res.results[0]?.canonicalUrl).toBe('https://example.com/post');
    expect(res.results[0]?.urlHash).toBe(expectedHash);
    expect(insertedUrlHash).toBe(expectedHash);
  });

  it('processes text ingest with embedding provider and clusters item', async () => {
    let embeddedTexts: string[] = [];
    const mockEmbeddingProvider = {
      embed: async (texts: string[]) => {
        embeddedTexts = texts;
        return [[0.1, 0.2, 0.3]];
      },
    };

    let updatedItemSet: Record<string, unknown> | null = null;
    let itemQueries = 0;
    const mockTrx: any = {
      selectFrom: (table: string) => {
        const queryObj: any = {
          leftJoin: () => queryObj,
          select: () => queryObj,
          where: () => queryObj,
          orderBy: () => queryObj,
          limit: () => queryObj,
          executeTakeFirst: async () => {
            if (table === 'sources') return { id: 'source-manual' };
            if (table === 'items') {
              itemQueries++;
              // 1-й запрос: проверка на дубликат по content_hash -> null
              // 2-й запрос: получение item.story_id -> { id: 'item-1', story_id: null }
              if (itemQueries === 1) return null;
              return { id: 'item-1', story_id: null };
            }
            if (table === 'stories') return null; // нет существующей story -> создаём новую
            return null;
          },
        };
        return queryObj;
      },
      deleteFrom: () => ({
        where: () => ({
          execute: async () => undefined,
        }),
      }),
      insertInto: (table: string) => ({
        values: () => {
          const chain: any = {
            onConflict: () => chain,
            returning: () => chain,
            executeTakeFirstOrThrow: async () => ({ id: table === 'stories' ? 'story-1' : 'item-1' }),
            executeTakeFirst: async () => ({ id: table === 'stories' ? 'story-1' : 'item-1' }),
            execute: async () => undefined,
          };
          return chain;
        },
      }),
      updateTable: () => ({
        set: (setVal: any) => {
          updatedItemSet = setVal;
          return {
            where: () => ({
              execute: async () => undefined,
            }),
          };
        },
      }),
    };

    const mockDb: any = {
      ...mockTrx,
      transaction: () => ({
        execute: async (fn: any) => fn(mockTrx),
      }),
    };

    const res = await processIngest(mockDb, {
      text: 'Интересный анонс новой модели LLM для локального запуска',
      submittedBy: 12345,
      role: 'owner',
      embeddingProvider: mockEmbeddingProvider as any,
    });

    expect(res.success).toBe(true);
    expect(res.acceptedCount).toBe(1);
    expect(embeddedTexts.length).toBe(1);
    expect(embeddedTexts[0]).toContain('Интересный анонс новой модели LLM');
    expect(updatedItemSet).not.toBeNull();
    expect(updatedItemSet?.fetch_status).toBe('ok');
    expect(updatedItemSet?.story_id).toBe('story-1');
  });
});

describe('Resolver trigger for forwards (M4, §5.3, agents/spec.md)', () => {
  interface MockQuery {
    leftJoin: () => MockQuery;
    innerJoin: () => MockQuery;
    select: () => MockQuery;
    where: () => MockQuery;
    orderBy: () => MockQuery;
    limit: () => MockQuery;
    executeTakeFirst: () => Promise<unknown>;
  }

  interface MockInsert {
    onConflict: () => MockInsert;
    returning: () => MockInsert;
    executeTakeFirstOrThrow: () => Promise<{ id: string }>;
    executeTakeFirst: () => Promise<{ id: string }>;
    execute: () => Promise<void>;
  }

  /** Мок БД в форме соседнего теста: ингест текста, дублей нет. */
  function createMockDb(): Kysely<Database> {
    let itemQueries = 0;
    const mockTrx = {
      selectFrom: (table: string): MockQuery => {
        const queryObj: MockQuery = {
          leftJoin: () => queryObj,
          innerJoin: () => queryObj,
          select: () => queryObj,
          where: () => queryObj,
          orderBy: () => queryObj,
          limit: () => queryObj,
          executeTakeFirst: async () => {
            if (table === 'sources') return { id: 'source-manual' };
            if (table === 'items') {
              itemQueries++;
              // 1-й запрос — проверка дубля по content_hash, 2-й — чтение story_id
              return itemQueries === 1 ? null : { id: 'item-1', story_id: null };
            }
            return null;
          },
        };
        return queryObj;
      },
      deleteFrom: () => ({ where: () => ({ execute: async () => undefined }) }),
      insertInto: (table: string) => ({
        values: (): MockInsert => {
          const id = table === 'stories' ? 'story-1' : 'item-1';
          const chain: MockInsert = {
            onConflict: () => chain,
            returning: () => chain,
            executeTakeFirstOrThrow: async () => ({ id }),
            executeTakeFirst: async () => ({ id }),
            execute: async () => undefined,
          };
          return chain;
        },
      }),
      updateTable: () => ({
        set: () => ({ where: () => ({ execute: async () => undefined }) }),
      }),
    };

    const mockDb = {
      ...mockTrx,
      transaction: () => ({
        execute: async (fn: (trx: typeof mockTrx) => unknown) => fn(mockTrx),
      }),
    };
    return mockDb as unknown as Kysely<Database>;
  }

  it('enqueues Resolver for a forwarded post without its own URL', async () => {
    const enqueued: ResolverJob[] = [];

    const res = await processIngest(createMockDb(), {
      text: 'Пересказ новости про открытую модель без единой ссылки',
      submittedBy: 12345,
      role: 'owner',
      isForward: true,
      forwardFromTitle: 'Канал-источник',
      enqueueResolver: async (job) => {
        enqueued.push(job);
      },
    });

    expect(res.acceptedCount).toBe(1);
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]!.itemId).toBe('item-1');
    expect(enqueued[0]!.channelTitle).toBe('Канал-источник');
    expect(enqueued[0]!.text).toContain('открытую модель');
  });

  it('does not enqueue Resolver for an owner note that is not a forward', async () => {
    const enqueued: ResolverJob[] = [];

    await processIngest(createMockDb(), {
      text: 'Своя заметка редактора для будущего поста',
      submittedBy: 12345,
      role: 'owner',
      enqueueResolver: async (job) => {
        enqueued.push(job);
      },
    });

    expect(enqueued).toHaveLength(0);
  });

  it('ingests forwards unchanged when no queue is wired', async () => {
    const res = await processIngest(createMockDb(), {
      text: 'Пересказ без очереди',
      submittedBy: 12345,
      role: 'owner',
      isForward: true,
    });

    expect(res.acceptedCount).toBe(1);
  });
});
