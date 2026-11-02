import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { rssAdapter } from '../../src/sources/adapters/rss.js';
import { hnAlgoliaAdapter } from '../../src/sources/adapters/hn-algolia.js';
import { getAdapter, listAdapters } from '../../src/sources/registry.js';

const FIXTURES = path.resolve(import.meta.dirname, '..', 'fixtures');

function fileFetcher(file: string, contentType: string) {
  return async () =>
    new Response(readFileSync(path.join(FIXTURES, file), 'utf8'), {
      status: 200,
      headers: { 'content-type': contentType },
    });
}

describe('rss-адаптер (fixture techcrunch.xml)', () => {
  const ctx = {
    sourceId: '00000000-0000-0000-0000-000000000001',
    config: { key: 'rss:techcrunch', url: 'https://techcrunch.com/feed/' },
    cursor: null,
    fetchLike: fileFetcher('techcrunch.xml', 'application/rss+xml'),
  };

  it('первый опрос берёт записи ленты и ставит водяную метку', async () => {
    const { refs, cursor } = await rssAdapter.discover(ctx);
    expect(refs.map((r) => r.externalId).sort()).toEqual(['tc-1000', 'tc-1001', 'tc-1002']);
    expect(cursor.lastTs).toBe('2026-08-19T09:30:00.000Z');
  });

  it('повторный опрос с курсором берёт только новое', async () => {
    const { refs } = await rssAdapter.discover({
      ...ctx,
      cursor: { lastTs: '2026-08-19T08:00:00.000Z' },
    });
    expect(refs.map((r) => r.externalId)).toEqual(['tc-1002']);
  });

  it('url с utm сохраняется как есть — канонизация дальше по конвейеру', async () => {
    const { refs } = await rssAdapter.discover(ctx);
    const withUtm = refs.find((r) => r.externalId === 'tc-1001')!;
    expect(withUtm.url).toContain('utm_source=twitter');
  });
});

describe('hn_algolia-адаптер (fixture front page)', () => {
  const ctx = {
    sourceId: '00000000-0000-0000-0000-000000000002',
    config: { key: 'hn-front-page', threshold: 50 },
    cursor: null,
    fetchLike: fileFetcher('hn-front-page.json', 'application/json'),
  };

  it('отбирает по порогу очков и пропускает записи без url', async () => {
    const { refs } = await hnAlgoliaAdapter.discover(ctx);
    expect(refs.map((r) => r.externalId).sort()).toEqual(['44000001', '44000002']);
    expect(refs.find((r) => r.externalId === '44000001')!.externalSignals).toEqual({ hn_points: 187 });
  });

  it('курсор отрезает старые записи', async () => {
    const { refs } = await hnAlgoliaAdapter.discover({
      ...ctx,
      cursor: { lastTs: '2026-08-19T09:00:00.000Z' },
    });
    expect(refs.map((r) => r.externalId)).toEqual(['44000002']);
  });
});

describe('реестр адаптеров', () => {
  it('выдаёт адаптеры по имени', () => {
    expect(listAdapters()).toContain('rss');
    expect(listAdapters()).toContain('hn_algolia');
    expect(getAdapter('rss').type).toBe('rss');
    expect(() => getAdapter('нет-такого')).toThrow(/Неизвестный адаптер/);
  });
});
